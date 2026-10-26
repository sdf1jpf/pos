import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text } from "./terminal";

const onHand = async (store: number, sku: string) =>
	(await env.DB.prepare("SELECT on_hand FROM stock WHERE store = ? AND sku = ?").bind(store, sku).first<{ on_hand: number }>())?.on_hand ?? 0;

describe("purchasing", () => {
	it("keeps vendors, suggests, orders, receives at average cost and returns to vendors", async () => {
		const a = terminal("ADMIN");
		await a.key("START");

		// The vendor codes already on items became vendors.
		let r = await a.key("ENTER", { option: "3.1" });
		expect(map(r)).toBe("POS360");
		expect(text(r)).toContain("HOMEGDS");
		r = await a.key("ENTER", { "sel:HOMEGDS": "S" });
		expect(map(r)).toBe("POS361");
		r = await a.key("ENTER", { name: "home goods inc", leadDays: "5", email: "nope" });
		expect(text(r)).toContain("POS3605E EMAIL LOOKS LIKE");
		r = await a.key("ENTER", { name: "home goods inc", leadDays: "5", email: "orders@homegoods.example" });
		expect(text(r)).toContain("POS3603I VENDOR HOMEGDS UPDATED");
		await a.key("PF3");
		await a.key("PF3");

		// Mugs at store 1: order at 2, up to 12.
		r = await a.key("ENTER", { option: "3.4" });
		expect(map(r)).toBe("POS373");
		r = await a.key("ENTER", { store: "1", vendor: "HOMEGDS" });
		expect(text(r)).toContain("MUG, STONEWARE 12 OZ");
		r = await a.key("ENTER", { "min:300100": "2" });
		expect(text(r)).toContain("POS3744E 300100: KEY BOTH MIN AND MAX");
		r = await a.key("ENTER", { "min:300100": "2", "max:300100": "12" });
		expect(text(r)).toContain("POS3745I 1 REORDER POINT(S) SAVED");
		await a.key("PF3");

		r = await a.key("ENTER", { option: "3.3" });
		expect(map(r)).toBe("POS372");
		r = await a.key("ENTER", { store: "1", vendor: "HOMEGDS" });
		expect(text(r)).toContain("2/12");
		r = await a.key("PF10");
		expect(map(r)).toBe("POS371");
		const first = Number(/PURCHASE ORDER (\d+) SAVED/.exec(text(r))![1]);
		expect(text(r)).toContain("DRAFT");
		r = await a.key("PF10");
		expect(text(r)).toContain(`POS3717I PURCHASE ORDER ${first} ORDERED FROM HOMEGDS`);

		// Five come, then the other seven.
		r = await a.key("ENTER", { "r:300100": "5" });
		expect(text(r)).toContain("STAYS OPEN FOR THE REST");
		expect(text(r)).toContain("PART RECEIVED");
		expect(await onHand(1, "300100")).toBe(5000);
		r = await a.key("ENTER", { "r:300100": "7" });
		expect(text(r)).toContain("IS CLOSED");
		expect(await onHand(1, "300100")).toBe(12000);
		// On order and over max now: nothing to suggest.
		await a.key("PF3");
		await a.key("PF3");
		r = await a.key("ENTER", { option: "3.3" });
		r = await a.key("ENTER", { store: "1", vendor: "HOMEGDS" });
		expect(text(r)).toContain("NOTHING TO ORDER");
		await a.key("PF3");

		// A PO keyed by hand, at a new cost: the mug's cost averages.
		r = await a.key("ENTER", { option: "3.2" });
		expect(map(r)).toBe("POS370");
		r = await a.key("PF5");
		r = await a.key("ENTER", { vendor: "HOMEGDS", store: "1", "sku:0": "400100", "qty:0": "1" });
		expect(text(r)).toContain("POS3714E 400100 COMES FROM VENDOR TOOLCO");
		r = await a.key("ENTER", { vendor: "HOMEGDS", store: "1", expected: "2026-13-01", "sku:0": "300100", "qty:0": "12", "cost:0": "3.00" });
		expect(text(r)).toContain("POS3714E DATE IS YYYY-MM-DD");
		r = await a.key("ENTER", { vendor: "HOMEGDS", store: "1", expected: "2026-11-02", "sku:0": "300100", "qty:0": "12", "cost:0": "3.00" });
		const second = Number(/PURCHASE ORDER (\d+) SAVED/.exec(text(r))![1]);
		await a.key("PF10");
		r = await a.key("PF10", { "r:300100": "12" });
		expect(text(r)).toContain("IS CLOSED");
		expect(await onHand(1, "300100")).toBe(24000);
		expect(await env.DB.prepare("SELECT cost FROM items WHERE sku = '300100'").first()).toEqual({ cost: 255 });
		const moves = await env.DB.prepare("SELECT kind, qty, reason FROM stock_moves WHERE sku = '300100' AND store = 1 ORDER BY id").all();
		expect(moves.results).toEqual([
			{ kind: "RECEIVE", qty: 5000, reason: `PO ${first}` },
			{ kind: "RECEIVE", qty: 7000, reason: `PO ${first}` },
			{ kind: "RECEIVE", qty: 12000, reason: `PO ${second}` },
		]);
		await a.key("PF3");
		r = await a.key("PF6");
		expect(text(r)).toContain("PURCHASE ORDERS - ALL");
		expect(text(r)).toContain("RECEIVED");
		await a.key("PF3");

		// Two chipped mugs go back.
		r = await a.key("ENTER", { option: "3.5" });
		expect(map(r)).toBe("POS380");
		r = await a.key("ENTER", { vendor: "HOMEGDS", store: "1", reason: "chipped", "sku:0": "300100", "qty:0": "2" });
		expect(text(r)).toMatch(/POS3803I RETURN \d+ TO HOMEGDS: 1 ITEM\(S\), 5.10 AT COST/);
		expect(await onHand(1, "300100")).toBe(22000);
	});

	it("lets a manager order and receive only for their stores", async () => {
		const m = terminal("MANAGER");
		await m.key("START");
		let r = await m.key("ENTER", { option: "3" });
		expect(text(r)).not.toContain("VENDORS");
		r = await m.key("ENTER", { option: "2" });
		r = await m.key("PF5");
		r = await m.key("ENTER", { vendor: "ACMEFOOD", store: "1", "sku:0": "100100", "qty:0": "6" });
		expect(text(r)).toContain("POS3713E YOU MAY NOT WORK ON STORE 1");
		r = await m.key("ENTER", { vendor: "ACMEFOOD", store: "2", "sku:0": "100100", "qty:0": "6" });
		expect(text(r)).toContain("SAVED AS A DRAFT");
	});
});
