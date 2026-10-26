import { describe, expect, it } from "vitest";
import { map, terminal, text, value } from "./terminal";

// A supervisor opens register 1 from the back office and a cashier signs on.
async function lane() {
	const t = terminal("SUPER");
	await t.key("START");
	await t.key("ENTER", { option: "R" });
	await t.key("ENTER", { store: "1", reg: "1" });
	await t.key("ENTER", { operator: "3001", pin: "1234" });
	return { t };
}

describe("scanning", () => {
	it("rings one per scan, and PF10 changes the last line's qty", async () => {
		const { t } = await lane();
		await t.key("ENTER", { "n:20": "2" });
		let r = await t.key("PF10");
		expect(map(r)).toBe("POS220");
		expect(value(r, "qty")).toBe("1");

		// A scanner types the UPC and presses Enter: nothing else.
		r = await t.key("ENTER", { item: "300100" });
		expect(text(r)).toContain("POS2210I MUG, STONEWARE 12 OZ 1 @ 5.99 = 5.99");
		expect(value(r, "qty")).toBe("1");
		r = await t.key("ENTER", { item: "300100" });
		expect(text(r)).toContain("ITEMS 2");

		// The shown 1 is never taken as pounds.
		r = await t.key("ENTER", { item: "200100" });
		expect(text(r)).toContain("POS2207E");
		expect(value(r, "qty")).toBe("");
		expect(value(r, "item")).toBe("200100");
		r = await t.key("ENTER", { qty: "1.5" });
		expect(text(r)).toContain("= 2.99");
		r = await t.key("PF10");
		expect(text(r)).toContain("POS2229E KEY THE POUNDS FOR LINE 3");
		r = await t.key("PF10", { qty: "2" });
		expect(text(r)).toContain("POS2230I LINE 3 APPLES, GALA NOW 2.000 LB @ 1.99 = 3.98");

		// PF10 takes LINE, as PF6 does; blank is the last line.
		r = await t.key("PF10", { qty: "3", line: "1" });
		expect(text(r)).toContain("POS2230I LINE 1 MUG, STONEWARE 12 OZ NOW 3 @ 5.99 = 17.97");
		r = await t.key("PF10", { qty: "0", line: "1" });
		expect(text(r)).toContain("POS2208E");
		r = await t.key("PF10", { line: "9" });
		expect(text(r)).toContain("POS2212E THERE IS NO LINE 9");
		await t.key("PF6", { line: "2" });
		r = await t.key("PF10", { qty: "4", line: "2" });
		expect(text(r)).toContain("POS2214E LINE 2 IS VOID");
	});
});
