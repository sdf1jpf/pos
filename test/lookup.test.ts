import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { grid, map, terminal, text, value } from "./terminal";

// A supervisor opens a register at store 1 from the back office and a
// cashier signs on to it.
async function lane(reg: string, operator: string) {
	const t = terminal("SUPER");
	await t.key("START");
	await t.key("ENTER", { option: "R" });
	await t.key("ENTER", { store: "1", reg });
	await t.key("ENTER", { operator, pin: "1234" });
	await t.key("ENTER", { "n:20": "2" });
	await t.key("PF10");
	return t;
}

describe("item lookup", () => {
	it("finds an item by description with price and on hand, and rings one", async () => {
		await env.DB.prepare("INSERT INTO stock (store, sku, on_hand, updated_at) VALUES (1, '300100', 12000, '2026-10-26T00:00:00Z'), (2, '300100', 5000, '2026-10-26T00:00:00Z')").run();
		const t = await lane("1", "3001");
		let r = await t.key("ENTER", { item: "MUG" });
		expect(text(r)).toContain("POS2203E ITEM MUG NOT FOUND - PF11 LOOKS IT UP");

		// What was keyed in ITEM is searched for.
		r = await t.key("PF11");
		expect(map(r)).toBe("POS237");
		expect(value(r, "q")).toBe("MUG");
		const g = grid(r);
		expect(g).toMatch(/300100\s+MUG, STONEWARE 12 OZ\s+5\.99\s+12/);
		expect(g).not.toContain("HAMMER");

		r = await t.key("ENTER", { "sel:300100": "S" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("POS2210I MUG, STONEWARE 12 OZ 1 @ 5.99 = 5.99");
		expect(text(r)).toContain("ITEMS 1");
	});

	it("searches every word, by SKU start and UPC, and sends weighed items back for pounds", async () => {
		const t = await lane("2", "3002");
		let r = await t.key("PF11");
		expect(map(r)).toBe("POS237");
		// Blank lists every item on sale, by description.
		expect(grid(r).indexOf("APPLES")).toBeLessThan(grid(r).indexOf("HAMMER"));

		r = await t.key("ENTER", { q: "oz ground" });
		expect(grid(r)).toContain("COFFEE, GROUND 12 OZ");
		expect(grid(r)).not.toContain("MUG");
		r = await t.key("ENTER", { q: "4001" });
		expect(grid(r)).toContain("HAMMER");
		r = await t.key("ENTER", { q: "012345678912" });
		expect(grid(r)).toContain("PASTA");
		expect(grid(r)).not.toContain("COFFEE");
		r = await t.key("ENTER", { q: "NOSUCH" });
		expect(text(r)).toContain("NOTHING ON SALE MATCHES NOSUCH");

		r = await t.key("ENTER", { q: "APPLES" });
		r = await t.key("ENTER", { "sel:200100": "X" });
		expect(text(r)).toContain("POS2371E");
		r = await t.key("ENTER", { "sel:200100": "S" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("POS2373I APPLES, GALA IS SOLD BY WEIGHT");
		expect(value(r, "item")).toBe("200100");
		r = await t.key("ENTER", { qty: "2" });
		expect(text(r)).toContain("APPLES, GALA 2.000 LB @ 1.99 = 3.98");

		// PF3 goes back to the sale as it was.
		r = await t.key("PF11");
		r = await t.key("PF3");
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("ITEMS 1");
	});
});
