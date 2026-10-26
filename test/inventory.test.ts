import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { postSale } from "../src/data/stock";
import { consume, sweep } from "../src/posting";
import { map, terminal, text } from "./terminal";

const onHand = async (store: number, sku: string) =>
	(await env.DB.prepare("SELECT on_hand FROM stock WHERE store = ? AND sku = ?").bind(store, sku).first<{ on_hand: number }>())?.on_hand ?? 0;

// A sale rung at store 1: two mugs and a pound and a half of apples.
async function ringSale() {
	const t = terminal("SUPER");
	await t.key("START");
	await t.key("ENTER", { option: "R" });
	await t.key("ENTER", { store: "1", reg: "1" });
	let r = await t.key("ENTER", { operator: "3001", pin: "1234" });
	if (map(r) === "POS211") await t.key("PF10", { "n:20": "5" });
	await t.key("ENTER", { item: "300100", qty: "2" });
	await t.key("ENTER", { item: "200100", qty: "1.5" });
	await t.key("PF5");
	r = await t.key("ENTER", { method: "C", amount: "50" });
	expect(map(r)).toBe("POS240");
	const id = Number(/SALE (\d+) COMPLETE/.exec(text(r))![1]);
	await t.key("ENTER");
	await t.key("PF4");
	await t.key("ENTER", { option: "6" });
	await t.key("PF3");
	return id;
}

describe("the stock ledger", () => {
	it("takes paid sales off on hand once, and puts post-voided ones back", async () => {
		const id = await ringSale();
		await sweep(env);
		expect(await onHand(1, "300100")).toBe(-2000);
		expect(await onHand(1, "200100")).toBe(-1500);
		// Posted again, by the queue or the sweep: nothing changes.
		const acked: number[] = [];
		await consume({ messages: [{ body: { sale: id }, ack: () => acked.push(id), retry: () => {} }] } as unknown as MessageBatch<{ sale: number }>, env);
		await postSale(env.DB, id);
		expect(acked).toEqual([id]);
		expect(await onHand(1, "300100")).toBe(-2000);
		const moves = await env.DB.prepare("SELECT kind, qty FROM stock_moves WHERE ref = ? ORDER BY id").bind(String(id)).all();
		expect(moves.results).toEqual([{ kind: "SALE", qty: -2000 }, { kind: "SALE", qty: -1500 }]);

		await env.DB.prepare("UPDATE sales SET status = 'V' WHERE id = ?").bind(id).run();
		expect(await sweep(env)).toBe(1);
		expect(await sweep(env)).toBe(0);
		expect(await onHand(1, "300100")).toBe(0);
		expect((await env.DB.prepare("SELECT posted FROM sales WHERE id = ?").bind(id).first())).toEqual({ posted: 2 });
	});
});

describe("inventory in the back office", () => {
	it("adjusts, counts and transfers stock, by store", async () => {
		const a = terminal("ADMIN");
		await a.key("START");
		let r = await a.key("ENTER", { option: "2.1" });
		expect(map(r)).toBe("POS310");
		r = await a.key("ENTER", { store: "1", q: "mug" });
		expect(text(r)).toContain("MUG, STONEWARE 12 OZ");

		r = await a.key("ENTER", { "sel:300100": "A" });
		expect(map(r)).toBe("POS312");
		r = await a.key("ENTER", { qty: "5", reason: "XX" });
		expect(text(r)).toContain("POS3126E REASON MUST BE");
		r = await a.key("ENTER", { qty: "5", reason: "fd" });
		expect(text(r)).toContain("POS3127I 300100 AT STORE 1 ADJUSTED +5");
		r = await a.key("ENTER", { qty: "-1", reason: "DM" });
		expect(text(r)).toContain("ADJUSTED -1");
		expect(await onHand(1, "300100")).toBe(4000);
		await a.key("PF3");
		r = await a.key("ENTER", { "sel:300100": "L" });
		expect(map(r)).toBe("POS311");
		expect(text(r)).toContain("ON HAND 4");
		expect(text(r)).toContain("ADJUSTED");
		await a.key("PF3");
		await a.key("PF3");

		// A cycle count of housewares: 10 mugs on the shelf.
		r = await a.key("ENTER", { option: "2.3" });
		expect(map(r)).toBe("POS320");
		r = await a.key("PF5", { store: "1", dept: "99" });
		expect(text(r)).toContain("POS3202E DEPARTMENT 99 NOT FOUND");
		r = await a.key("PF5", { store: "1", dept: "30" });
		expect(map(r)).toBe("POS321");
		expect(text(r)).toContain("CYCLE COUNT OF DEPT 30");
		r = await a.key("PF10");
		expect(text(r)).toContain("POS3213E NOTHING HAS BEEN COUNTED YET");
		r = await a.key("ENTER", { "n:300100": "x" });
		expect(text(r)).toContain("POS3217E");
		r = await a.key("ENTER", { "n:300100": "10" });
		expect(text(r)).toContain("POS3218I 1 COUNT(S) SAVED");
		expect(text(r)).toContain("+6");
		r = await a.key("PF10");
		expect(text(r)).toContain("POS3214I");
		expect(text(r)).toContain("POSTED");
		expect(await onHand(1, "300100")).toBe(10000);
		await a.key("PF3");
		await a.key("PF3");

		// Three sent from store 1 to store 2; two arrive.
		r = await a.key("ENTER", { option: "2.4" });
		expect(map(r)).toBe("POS330");
		r = await a.key("PF5");
		r = await a.key("ENTER", { from: "1", to: "1", "sku:0": "300100", "qty:0": "3" });
		expect(text(r)).toContain("POS3314E THE STORES MUST DIFFER");
		r = await a.key("ENTER", { from: "1", to: "2", "sku:0": "nosuch", "qty:0": "3" });
		expect(text(r)).toContain("POS3314E ITEM NOSUCH NOT FOUND");
		r = await a.key("ENTER", { from: "1", to: "2", "sku:0": "300100", "qty:0": "3" });
		const xfer = Number(/TRANSFER (\d+) STARTED/.exec(text(r))![1]);
		r = await a.key("PF10");
		expect(text(r)).toContain(`POS3317I TRANSFER ${xfer} SENT`);
		expect(await onHand(1, "300100")).toBe(7000);

		// The manager of store 2 receives it.
		const m = terminal("MANAGER");
		await m.key("START");
		r = await m.key("ENTER", { option: "2.4" });
		expect(text(r)).toContain("SENT");
		r = await m.key("ENTER", { [`sel:${xfer}`]: "S" });
		expect(map(r)).toBe("POS331");
		r = await m.key("PF10", { "r:300100": "2" });
		expect(text(r)).toContain(`POS3322I TRANSFER ${xfer} RECEIVED AT STORE 2`);
		expect(await onHand(2, "300100")).toBe(2000);
		// Store 2's manager can't touch store 1's stock.
		await m.key("PF3");
		await m.key("PF3");
		r = await m.key("ENTER", { option: "2.1" });
		expect(text(r)).toContain("2");
		r = await m.key("ENTER", { store: "1" });
		expect(text(r)).toContain("POS3101E YOU MAY NOT WORK ON STORE 1");
	});
});
