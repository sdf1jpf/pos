import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { nextDay } from "../src/data/endofday";
import { map, terminal, text } from "./terminal";

// waitFor checks until a condition holds: the close runs as a Workflow,
// after the key that starts it is answered.
async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
	for (let i = 0; i < 60; i++) {
		const v = await get();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

const businessDay = async () => (await env.DB.prepare("SELECT COALESCE(NULLIF(business_day, ''), date('now')) AS d FROM stores WHERE store = 1").first<{ d: string }>())!.d;

describe("end of day", () => {
	it("works out the next business day", () => {
		expect(nextDay("2026-10-26", "2026-10-26")).toBe("2026-10-27");
		expect(nextDay("2026-10-31", "2026-10-26")).toBe("2026-11-01");
		expect(nextDay("2026-10-20", "2026-10-26")).toBe("2026-10-26");
	});

	it("closes a store's day once its drawers are closed, with a Z report, and reopens it", async () => {
		const day = await businessDay();
		// A sale at register 1: a mug, paid in cash.
		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "1", reg: "1" });
		await t.key("ENTER", { operator: "3001", pin: "1234" });
		await t.key("PF10", { "n:20": "5" });
		await t.key("ENTER", { item: "300100" });
		await t.key("PF5");
		let r = await t.key("ENTER", { method: "C", amount: "10" });
		expect(map(r)).toBe("POS240");
		await t.key("ENTER");

		const a = terminal("ADMIN");
		await a.key("START");
		r = await a.key("ENTER", { option: "5.1" });
		expect(map(r)).toBe("POS510");
		r = await a.key("ENTER", { store: "1" });
		expect(text(r)).toContain(`BUSINESS DAY ${day}`);
		expect(text(r)).toContain("OPEN DRAWERS");
		r = await a.key("PF10");
		expect(text(r)).toContain("POS5102E CLOSE EVERY DRAWER FIRST");

		// The drawer is counted out: 100.00 float plus 6.42.
		await t.key("PF4");
		await t.key("ENTER", { option: "5" });
		r = await t.key("PF10", { "n:20": "5", "n:5": "1", "n:1": "1", "n:.25": "1", "n:.10": "1", "n:.05": "1", "n:.01": "2" });
		expect(text(r)).toContain("CLOSED");
		await t.key("ENTER");
		await t.key("PF3");

		r = await a.key("ENTER");
		expect(text(r)).toContain("EVERY DRAWER IS CLOSED");
		r = await a.key("PF10");
		expect(text(r)).toContain(`POS5103I CLOSING DAY ${day}`);
		const closed = await waitFor(
			() => env.DB.prepare("SELECT status, z FROM store_days WHERE store = 1 AND day = ?").bind(day).first<{ status: string; z: string }>(),
			(x) => x?.status === "C",
		);
		const z = JSON.parse(closed!.z);
		expect(z).toMatchObject({ sales: 1, total: 642, tax: 43, merchandise: 599, tenders: { CASH: 642 }, overShort: 0, deposit: { cash: 642, total: 642 } });
		expect(await businessDay()).not.toBe(day);
		// The sale was posted to the ledger as part of the close.
		expect(await env.DB.prepare("SELECT on_hand FROM stock WHERE store = 1 AND sku = '300100'").first()).toEqual({ on_hand: -1000 });
		r = await a.key("ENTER");
		expect(text(r)).toContain(`DAY ${day}: CLOSED`);
		// The next day can't be closed before it starts.
		r = await a.key("PF10");
		expect(text(r)).toContain("HASN'T STARTED YET");

		// Its Z report, in 5.2.
		await a.key("PF3");
		r = await a.key("ENTER", { option: "5.2" });
		expect(map(r)).toBe("POS520");
		r = await a.key("ENTER", { store: "1" });
		expect(text(r)).toContain(day);
		r = await a.key("ENTER", { [`sel:${day}`]: "S" });
		expect(map(r)).toBe("POS521");
		expect(text(r)).toContain("Z REPORT - STORE 1");
		r = await a.key("PF8");
		expect(text(r)).toContain("DEPOSIT TOTAL");
		await a.key("PF3");
		await a.key("PF3");

		// Reopened by an admin: the store is back on that day.
		r = await a.key("ENTER", { option: "5.1" });
		r = await a.key("PF11", { store: "1" });
		r = await a.key("PF11");
		expect(text(r)).toContain(`POS5104I DAY ${day} REOPENED`);
		expect(await businessDay()).toBe(day);

		// A manager can close but not reopen.
		const m = terminal("MANAGER");
		await m.key("START");
		r = await m.key("ENTER", { option: "5.1" });
		expect(text(r)).not.toContain("PF11=REOPEN");
	});
});
