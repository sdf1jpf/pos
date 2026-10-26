import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text, type Reply } from "./terminal";

// A supervisor opens a register from the back office, a cashier signs on
// and the drawer is opened with 100.00.
async function lane(reg = "1") {
	const t = terminal("SUPER");
	await t.key("START");
	await t.key("ENTER", { option: "R" });
	await t.key("ENTER", { store: "1", reg });
	let r = await t.key("ENTER", { operator: "3001", pin: "1234" });
	if (map(r) === "POS211") r = await t.key("PF10", { "n:20": "5" });
	expect(map(r)).toBe("POS220");
	return t;
}

// signOff signs the operator off and gives the register up, for the next
// test to open.
async function signOff(t: ReturnType<typeof terminal>) {
	await t.key("PF4");
	expect(map(await t.key("ENTER", { option: "6" }))).toBe("POS210");
	await t.key("PF3");
}

const saleId = (r: Reply) => Number(/SALE (\d+) COMPLETE/.exec(text(r))![1]);

describe("returns", () => {
	it("come back from a receipt, refunded at what was paid, never more than was sold", async () => {
		const t = await lane();
		await t.key("ENTER", { item: "300100", qty: "2" });
		await t.key("ENTER", { item: "100100" });
		await t.key("PF5");
		let r = await t.key("ENTER", { method: "C", amount: "25" });
		const sold = saleId(r);
		await t.key("ENTER");

		r = await t.key("PF4");
		r = await t.key("ENTER", { option: "8" });
		expect(map(r)).toBe("POS232");
		r = await t.key("ENTER", { receipt: "1-01-999999" });
		expect(text(r)).toContain("POS2326E RECEIPT 1-01-999999 NOT FOUND");
		r = await t.key("ENTER", { receipt: `*1-01-${String(sold).padStart(6, "0")}*` });
		expect(text(r)).toContain("POS2328I");
		expect(text(r)).toContain("MUG, STONEWARE 12 OZ");
		r = await t.key("ENTER", { "rq:1": "3" });
		expect(text(r)).toContain("POS2329E ONLY 2 OF LINE 1 CAN COME BACK");
		r = await t.key("ENTER", { "rq:1": "1" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("POS2332I 1 LINE(S) RETURNED");
		expect(text(r)).toContain("-5.99");

		r = await t.key("PF5");
		expect(text(r)).toContain("REFUND DUE");
		r = await t.key("ENTER", { method: "K" });
		expect(text(r)).toContain("POS2313E");
		r = await t.key("ENTER", { method: "C" });
		expect(map(r)).toBe("POS240");
		const ret = saleId(r);
		r = await t.key("PF8");
		expect(text(r)).toContain(`RETURN FROM ${sold} LINE 1`);
		expect(text(r)).toContain("REFUND CASH");
		await t.key("ENTER");

		const back = await env.DB.prepare("SELECT total, tax FROM sales WHERE id = ?").bind(ret).first();
		expect(back).toEqual({ total: -642, tax: -43 });
		const tender = await env.DB.prepare("SELECT kind, amount FROM sale_tenders WHERE sale = ?").bind(ret).first();
		expect(tender).toEqual({ kind: "CASH", amount: -642 });
		const line = await env.DB.prepare("SELECT returned FROM sale_lines WHERE sale = ? AND line = 1").bind(sold).first();
		expect(line).toEqual({ returned: 1000 });

		// The other mug, twice on the same sale: the second is refused.
		await t.key("PF4");
		await t.key("ENTER", { option: "8" });
		await t.key("ENTER", { receipt: String(sold) });
		r = await t.key("ENTER", { "rq:1": "1" });
		expect(map(r)).toBe("POS220");
		await t.key("PF4");
		await t.key("ENTER", { option: "8" });
		await t.key("ENTER", { receipt: String(sold) });
		r = await t.key("ENTER", { "rq:1": "1" });
		expect(text(r)).toContain("POS2329E ONLY 0 OF LINE 1 CAN COME BACK");
		await t.key("PF3");

		// Paid for, the second return counts too.
		await t.key("PF5");
		r = await t.key("ENTER", { method: "C" });
		expect(map(r)).toBe("POS240");
		await t.key("ENTER");
		const again = await env.DB.prepare("SELECT returned FROM sale_lines WHERE sale = ? AND line = 1").bind(sold).first();
		expect(again).toEqual({ returned: 2000 });
		await signOff(t);
	});

	it("without a receipt need approval and are refunded as store credit, which pays later", async () => {
		const t = await lane();
		await t.key("PF4");
		await t.key("ENTER", { option: "8" });
		let r = await t.key("PF5");
		expect(text(r)).toContain("RETURN WITHOUT A RECEIPT");
		r = await t.key("ENTER", { item: "300100", qty: "1" });
		expect(map(r)).toBe("POS290");
		r = await t.key("ENTER", { operator: "4001", pin: "1234" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("-5.99");

		await t.key("PF5");
		r = await t.key("ENTER", { method: "C" });
		expect(text(r)).toContain("POS2314E");
		r = await t.key("ENTER", { method: "S" });
		expect(map(r)).toBe("POS240");
		const ret = saleId(r);
		await t.key("ENTER");
		const tender = await env.DB.prepare("SELECT kind, amount, ref FROM sale_tenders WHERE sale = ?").bind(ret).first<{ kind: string; amount: number; ref: string }>();
		expect(tender?.kind).toBe("CREDIT");
		expect(tender?.amount).toBe(-642);
		expect(tender?.ref).toMatch(/^SC\d{12}$/);
		const card = await env.DB.prepare("SELECT kind, balance FROM cards WHERE number = ?").bind(tender!.ref).first();
		expect(card).toEqual({ kind: "CREDIT", balance: 642 });
		const audit = await env.DB.prepare("SELECT approver FROM audit WHERE action = 'SALE.RETURN' AND subject = ?").bind(String(ret)).first();
		expect(audit).toEqual({ approver: "OP4001" });

		// The credit pays toward a hammer, the rest in cash.
		await t.key("ENTER", { item: "400100" });
		await t.key("PF5");
		r = await t.key("ENTER", { method: "S", ref: tender!.ref });
		expect(text(r)).toContain("POS2320E");
		expect(text(r)).toContain("HOLDS ONLY 6.42");
		r = await t.key("ENTER", { method: "S", amount: "6.42", ref: tender!.ref });
		expect(text(r)).toContain("POS2311I CREDIT 6.42 APPLIED");
		r = await t.key("ENTER", { method: "C", amount: "20" });
		expect(map(r)).toBe("POS240");
		r = await t.key("PF8");
		expect(text(r)).toContain("BALANCE NOW");
		const spent = await env.DB.prepare("SELECT balance FROM cards WHERE number = ?").bind(tender!.ref).first();
		expect(spent).toEqual({ balance: 0 });
		await t.key("ENTER");
		await signOff(t);
	});
});

describe("gift cards", () => {
	it("are sold as a line, loaded when paid for, and spent", async () => {
		const t = await lane();
		await t.key("PF4");
		let r = await t.key("ENTER", { option: "9" });
		expect(map(r)).toBe("POS235");
		r = await t.key("ENTER", { card: "12345", amount: "50" });
		expect(text(r)).toContain("POS2351E");
		r = await t.key("ENTER", { card: "6006491234567890", amount: "1000" });
		expect(text(r)).toContain("POS2355E");
		r = await t.key("ENTER", { card: "6006491234567890", amount: "50" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("GIFT CARD *7890");
		// No discount on a gift card.
		await t.key("PF9");
		r = await t.key("ENTER", { line: "1", disc: "5%" });
		expect(text(r)).toContain("POS2282E");
		await t.key("PF3");
		await t.key("PF5");
		r = await t.key("ENTER", { method: "C" });
		expect(map(r)).toBe("POS240");
		await t.key("ENTER");
		expect(await env.DB.prepare("SELECT kind, balance FROM cards WHERE number = '6006491234567890'").first()).toEqual({ kind: "GIFT", balance: 5000 });

		await t.key("PF4");
		await t.key("ENTER", { option: "9" });
		r = await t.key("PF2", { card: "6006491234567890" });
		expect(text(r)).toContain("POS2353I GIFT CARD 6006491234567890 HOLDS 50.00");
		await t.key("PF3");

		await t.key("ENTER", { item: "100100" });
		await t.key("PF5");
		r = await t.key("ENTER", { method: "G", ref: "1111222233334444" });
		expect(text(r)).toContain("POS2318E");
		r = await t.key("ENTER", { method: "G", ref: "6006491234567890" });
		expect(map(r)).toBe("POS240");
		r = await t.key("PF8");
		expect(text(r)).toContain("GIFT CARD *7890");
		expect(text(r)).toContain("42.01");
		expect(await env.DB.prepare("SELECT balance FROM cards WHERE number = '6006491234567890'").first()).toEqual({ balance: 4201 });
		await t.key("ENTER");
		await signOff(t);
	});
});

describe("customers and suspended sales", () => {
	it("a tax-exempt customer pays no tax, and a suspended sale resumes at another register", async () => {
		const t = await lane();
		await t.key("ENTER", { item: "300100" });
		await t.key("PF4");
		let r = await t.key("ENTER", { option: "7" });
		expect(map(r)).toBe("POS234");
		r = await t.key("ENTER", { phone: "555-1234" });
		expect(text(r)).toContain("POS2342E");
		r = await t.key("ENTER", { phone: "(937) 555-1234" });
		expect(text(r)).toContain("POS2343I");
		r = await t.key("ENTER", { name: "acme church", exempt: "Y" });
		expect(text(r)).toContain("POS2344E");
		r = await t.key("ENTER", { name: "acme church", exempt: "Y", exemptId: "OH-12345" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("POS2345I CUSTOMER ACME CHURCH - TAX EXEMPT");
		expect(text(r)).toContain("TOTAL       5.99");

		// Between-sale functions wait for the sale to finish.
		await t.key("PF4");
		r = await t.key("ENTER", { option: "11" });
		expect(text(r)).toContain("POS2253E");
		r = await t.key("ENTER", { option: "10" });
		expect(map(r)).toBe("POS220");
		const no = Number(/POS2255I SALE SUSPENDED AS NO\. (\d+)/.exec(text(r))![1]);
		expect(text(r)).not.toContain("MUG");
		await signOff(t);

		// At register 2, the same store.
		const u = await lane("2");
		await u.key("PF4");
		r = await u.key("ENTER", { option: "11" });
		expect(map(r)).toBe("POS236");
		expect(text(r)).toContain("5.99");
		r = await u.key("ENTER", { [`sel:${no}`]: "S" });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain(`POS2363I SALE ${no} RESUMED`);
		expect(text(r)).toContain("MUG, STONEWARE 12 OZ");
		expect(text(r)).toContain("ACME CHURCH");
		await u.key("PF5");
		r = await u.key("ENTER", { method: "C" });
		expect(map(r)).toBe("POS240");
		const id = saleId(r);
		r = await u.key("PF8");
		expect(text(r)).toContain("TAX EXEMPT OH-12345");
		const sale = await env.DB.prepare("SELECT s.tax, s.total, c.name FROM sales s JOIN customers c ON c.id = s.customer WHERE s.id = ?").bind(id).first();
		expect(sale).toEqual({ tax: 0, total: 599, name: "ACME CHURCH" });
		expect(await env.DB.prepare("SELECT status, resumed_reg FROM suspended WHERE id = ?").bind(no).first()).toEqual({ status: "R", resumed_reg: 2 });

		// Resumed once only.
		await u.key("ENTER");
		await u.key("PF4");
		r = await u.key("ENTER", { option: "11" });
		expect(text(r)).toContain("NO SALES ARE SUSPENDED");
		await u.key("PF3");
		await signOff(u);
	});
});
