import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { priceAt } from "../src/data/items";
import { map, terminal, text, value } from "./terminal";

async function at(user: string, option: string) {
	const t = terminal(user);
	await t.key("START");
	const r = await t.key("ENTER", { option });
	return { t, r };
}

describe("items", () => {
	it("lists and searches the item master", async () => {
		const { t, r } = await at("BUYER", "1.1");
		expect(map(r)).toBe("POS110");
		expect(text(r)).toContain("ROW 1 TO 6 OF 6");
		let s = await t.key("ENTER", { q: "hammer" });
		expect(text(s)).toContain("HAMMER, CLAW 16 OZ");
		expect(text(s)).toContain("ROW 1 TO 1 OF 1");
		s = await t.key("ENTER", { q: "", dept: "20" });
		expect(text(s)).toContain("BANANAS");
		expect(text(s)).not.toContain("HAMMER");
		s = await t.key("ENTER", { q: "012345678912", dept: "" });
		expect(text(s)).toContain("PASTA");
		s = await t.key("ENTER", { q: "%" });
		expect(text(s)).toContain("NO ITEMS MATCH");
	});

	it("adds an item, refusing bad fields, and takes the department's tax flag", async () => {
		const { t } = await at("BUYER", "1.1");
		let r = await t.key("PF5");
		expect(map(r)).toBe("POS111");
		const typed = { sku: "500100", upc: "", desc: "Garden hose, 50 ft", dept: "99", class: "", vendor: "", cost: "8.10", price: "24.99", taxable: "", weighed: "N", status: "A" };
		r = await t.key("ENTER", typed);
		expect(text(r)).toContain("POS0106E DEPARTMENT NOT FOUND");
		expect(value(r, "desc")).toBe("Garden hose, 50 ft"); // what was typed is kept
		r = await t.key("ENTER", { ...typed, dept: "40", price: "abc" });
		expect(text(r)).toContain("POS0106E PRICE MUST BE DOLLARS AND CENTS");
		r = await t.key("ENTER", { ...typed, dept: "40" });
		expect(text(r)).toContain("POS0105I ITEM 500100 ADDED");
		expect(text(r)).toContain("GARDEN HOSE, 50 FT");
		expect(value(r, "taxable")).toBe("Y");
		r = await t.key("PF3");
		expect(map(r)).toBe("POS110");
		const row = await env.DB.prepare("SELECT action, userid FROM audit WHERE subject = '500100'").first();
		expect(row).toEqual({ action: "ITEM.ADD", userid: "BUYER" });
	});

	it("refuses a duplicate SKU or UPC", async () => {
		const { t } = await at("ADMIN", "1.1");
		await t.key("PF5");
		let r = await t.key("ENTER", { sku: "100100", desc: "X", dept: "10", price: "1" });
		expect(text(r)).toContain("SKU 100100 ALREADY EXISTS");
		r = await t.key("ENTER", { sku: "100999", upc: "012345678905", desc: "X", dept: "10", price: "1" });
		expect(text(r)).toContain("UPC IS ALREADY ON SKU 100100");
	});

	it("updates an item and refuses a change made over someone else's", async () => {
		const a = await at("BUYER", "1.1");
		let r = await a.t.key("ENTER", { "sel:300100": "S" });
		expect(map(r)).toBe("POS111");
		expect(value(r, "price")).toBe("5.99");
		const b = await at("ADMIN", "1.1");
		await b.t.key("ENTER", { "sel:300100": "S" });
		r = await b.t.key("ENTER", { price: "6.49" });
		expect(text(r)).toContain("POS0104I ITEM 300100 UPDATED");
		// A still has version 1 on screen.
		r = await a.t.key("ENTER", { price: "5.49" });
		expect(text(r)).toContain("POS0106W SKU 300100 WAS CHANGED BY ADMIN");
		expect(value(r, "price")).toBe("6.49");
		r = await a.t.key("ENTER", { price: "5.49" });
		expect(text(r)).toContain("UPDATED");
	});

	it("gives a picked department from field help", async () => {
		const { t } = await at("BUYER", "1.1");
		await t.key("PF5");
		let r = await t.key("PF1", {}, "dept");
		expect(map(r)).toBe("POSH01");
		expect(text(r)).toContain("HOUSEWARES");
		r = await t.key("ENTER", { "pick:2": "S" });
		expect(value(r, "dept")).toBe("30");
	});
});

describe("departments", () => {
	it("adds and changes departments in place", async () => {
		const { t, r } = await at("BUYER", "1.2");
		expect(map(r)).toBe("POS120");
		let s = await t.key("ENTER", { dept: "50", name: "garden", taxable: "Y" });
		expect(text(s)).toContain("POS0202I 1 DEPARTMENT(S) SAVED");
		expect(value(s, "name:50")).toBe("GARDEN");
		s = await t.key("ENTER", { "name:50": "LAWN AND GARDEN", "tax:50": "N" });
		expect(value(s, "tax:50")).toBe("N");
		s = await t.key("ENTER", { "st:50": "Q" });
		expect(text(s)).toContain("POS0201E DEPARTMENT 50: STATUS MUST BE A");
		s = await t.key("ENTER", { dept: "10", name: "DUP" });
		expect(text(s)).toContain("DEPARTMENT 10 ALREADY EXISTS");
	});
});

describe("price book", () => {
	it("sets and clears a store's own price", async () => {
		const { t } = await at("BUYER", "1.3");
		let r = await t.key("ENTER", { store: "1" });
		expect(text(r)).toContain("MAIN STREET");
		expect(value(r, "price:100200")).toBe("");
		r = await t.key("ENTER", { "price:100200": "1.29" });
		expect(text(r)).toContain("POS0305I 1 PRICE(S) SAVED FOR STORE 1");
		expect(await priceAt(env.DB, 1, "100200")).toBe(129);
		expect(await priceAt(env.DB, 2, "100200")).toBe(149);
		r = await t.key("ENTER", { "price:100200": "" });
		expect(await priceAt(env.DB, 1, "100200")).toBe(149);
		r = await t.key("ENTER", { "price:100200": "x" });
		expect(text(r)).toContain("POS0304E PRICE FOR 100200");
	});

	it("keeps a manager to their own stores", async () => {
		const { t, r } = await at("MANAGER", "1.3");
		expect(text(r)).toContain("RIVERSIDE"); // their store, shown straight away
		expect(value(r, "price:100100")).toBe("8.49");
		const s = await t.key("ENTER", { store: "1" });
		expect(text(s)).toContain("POS0303E YOU MAY NOT CHANGE STORE 1'S PRICES");
	});
});
