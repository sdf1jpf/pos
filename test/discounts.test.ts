import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text } from "./terminal";

describe("promotions, coupons, discounts and overrides", () => {
	it("are kept in the back office and taken at the register", async () => {
		const buyer = terminal("BUYER");
		await buyer.key("START");
		let r = await buyer.key("ENTER", { option: "1.4" });
		expect(map(r)).toBe("POS140");
		await buyer.key("PF5");
		r = await buyer.key("ENTER", { name: "mugs bogo", kind: "bogo", qty: "1", free: "1", pct: "100", starts: "2026-01-01", items: "300100" });
		expect(text(r)).toMatch(/POS1404I PROMOTION \d+ ADDED/);
		expect(text(r)).toContain("BUY 1 GET 1 FREE");
		await buyer.key("PF3");
		await buyer.key("PF3");
		r = await buyer.key("ENTER", { option: "1.5" });
		expect(map(r)).toBe("POS150");
		await buyer.key("PF5");
		r = await buyer.key("ENTER", { code: "300100", desc: "x", value: "1.00", starts: "2026-01-01" });
		expect(text(r)).toContain("POS1505E 300100 IS AN ITEM'S SKU OR UPC");
		r = await buyer.key("ENTER", { code: "SAVE5", desc: "5 off 20", value: "5.00", minTotal: "20.00", starts: "2026-01-01" });
		expect(text(r)).toContain("POS1504I COUPON SAVE5 ADDED");

		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "1", reg: "1" });
		await t.key("ENTER", { operator: "3001", pin: "1234" });
		await t.key("PF10", { "n:20": "2" });

		r = await t.key("ENTER", { item: "300100", qty: "2" });
		expect(text(r)).toContain("MUGS BOGO");
		expect(text(r)).toContain("-5.99");
		r = await t.key("ENTER", { item: "save5" });
		expect(text(r)).toContain("POS2224E COUPON SAVE5 TAKES NOTHING OFF - THE SALE MUST COME TO 20.00");
		await t.key("ENTER", { item: "400100" });
		r = await t.key("ENTER", { item: "SAVE5" });
		expect(text(r)).toContain("POS2225I COUPON SAVE5 5 OFF 20 - 5.00 OFF");
		r = await t.key("ENTER", { item: "SAVE5" });
		expect(text(r)).toContain("POS2222E");

		// Within the store's 10% limit, no one need approve.
		r = await t.key("PF9");
		expect(map(r)).toBe("POS227");
		r = await t.key("ENTER", { line: "2", disc: "5%" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("POS2281I LINE 2 HAMMER, CLAW 16 OZ 5% OFF");

		// Over it, a supervisor must.
		await t.key("PF9");
		r = await t.key("ENTER", { line: "2", disc: "25%" });
		expect(map(r)).toBe("POS290");
		expect(text(r)).toContain("LINE 2 HAMMER, CLAW 16 OZ 25% OFF");
		r = await t.key("ENTER", { operator: "3001", pin: "1234" });
		expect(text(r)).toContain("POS2905E");
		r = await t.key("ENTER", { operator: "4001", pin: "1234" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("APPROVED BY SAM SUPERVISOR");

		// A price override always needs one, and a reason.
		await t.key("PF9");
		r = await t.key("ENTER", { line: "1", price: "4.99", reason: "XX" });
		expect(text(r)).toContain("POS2278E REASON MUST BE");
		r = await t.key("ENTER", { line: "1", price: "4.99", reason: "pm" });
		expect(map(r)).toBe("POS290");
		r = await t.key("ENTER", { operator: "4001", pin: "1234" });
		expect(map(r)).toBe("POS220");

		await t.key("PF9");
		r = await t.key("ENTER", { disc: "5%" });
		expect(text(r)).toContain("POS2281I SALE DISCOUNT 5%");
		expect(text(r)).toContain("TOTAL      20.08");

		await t.key("PF5");
		r = await t.key("ENTER", { method: "C" });
		expect(map(r)).toBe("POS240");
		const id = Number(/SALE (\d+) COMPLETE/.exec(text(r))![1]);
		r = await t.key("PF8");
		expect(text(r)).toContain("YOU SAVED 11.25");

		const sale = await env.DB.prepare("SELECT subtotal, discount, tax, total FROM sales WHERE id = ?").bind(id).first();
		expect(sale).toEqual({ subtotal: 2997, discount: 1125, tax: 136, total: 2008 });
		const lines = await env.DB.prepare("SELECT orig_price AS orig, reason, discount, net FROM sale_lines WHERE sale = ? ORDER BY line").bind(id).all();
		expect(lines.results).toEqual([{ orig: 599, reason: "PM", discount: 250, net: 748 }, { orig: null, reason: "", discount: 875, net: 1124 }]);
		const adjs = await env.DB.prepare("SELECT kind, line, code, amount, approver FROM sale_adjustments WHERE sale = ? ORDER BY seq").bind(id).all();
		expect(adjs.results).toEqual([
			{ kind: "OVERRIDE", line: 1, code: "PM", amount: 200, approver: "OP4001" },
			{ kind: "LINEDISC", line: 2, code: "25%", amount: 500, approver: "OP4001" },
			{ kind: "SALEDISC", line: null, code: "5%", amount: 125, approver: null },
			{ kind: "COUPON", line: null, code: "SAVE5", amount: 500, approver: null },
		]);
		const audit = await env.DB.prepare("SELECT action, approver FROM audit WHERE subject = ? AND approver IS NOT NULL ORDER BY id").bind(String(id)).all();
		expect(audit.results).toEqual([{ action: "SALE.OVERRIDE", approver: "OP4001" }, { action: "SALE.DISCOUNT", approver: "OP4001" }]);
	});
});
