import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { map, terminal, text } from "./terminal";

const today = () => new Date().toISOString().slice(0, 10);

describe("reports", () => {
	it("reports a day's sales, margin, tenders and stock, on screen and as a PDF", async () => {
		// Two mugs and a return without a receipt at store 1, paid in cash.
		await env.DB.prepare("INSERT INTO stock (store, sku, on_hand, min_qty, max_qty, updated_at) VALUES (1, '300100', 1000, 2000, 12000, '2026-10-26T00:00:00Z')").run();
		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "1", reg: "1" });
		await t.key("ENTER", { operator: "3001", pin: "1234" });
		await t.key("PF10", { "n:20": "5" });
		await t.key("ENTER", { item: "300100", qty: "2" });
		await t.key("PF5");
		let r = await t.key("ENTER", { method: "C", amount: "20" });
		expect(map(r)).toBe("POS240");
		await t.key("ENTER");
		const sale = (await env.DB.prepare("SELECT id, total FROM sales ORDER BY id DESC").first<{ id: number; total: number }>())!;

		const a = terminal("MANAGER");
		await a.key("START");
		r = await a.key("ENTER", { option: "6" });
		expect(map(r)).toBe("POS610");
		expect(text(r)).toContain("SALES AND MARGIN BY DEPARTMENT");
		r = await a.key("ENTER", { report: "SD", store: "1" });
		expect(text(r)).toContain("POS6101E YOU MAY NOT WORK ON STORE 1");
		r = await a.key("ENTER", { report: "ZZ", store: "" });
		expect(text(r)).toContain("REPORT IS ONE OF");
		r = await a.key("ENTER", { report: "SD", store: "" });
		expect(map(r)).toBe("POS611");
		expect(text(r)).toContain("STORE 2");
		expect(text(r)).toContain("NO SALES"); // the sale was at store 1

		const b = terminal("ADMIN");
		await b.key("START");
		await b.key("ENTER", { option: "6" });
		r = await b.key("ENTER", { report: "SD", store: "1" });
		expect(text(r)).toContain(today());
		expect(text(r)).toContain(`${(sale.total / 100).toFixed(2)}`);
		await b.key("PF3");
		r = await b.key("ENTER", { report: "SP", store: "1" });
		expect(text(r)).toContain("SALES AND MARGIN BY DEPARTMENT");
		expect(text(r)).toMatch(/TOTAL/);
		await b.key("PF3");
		r = await b.key("ENTER", { report: "ST", store: "1" });
		expect(text(r)).toContain("CASH");
		await b.key("PF3");
		r = await b.key("ENTER", { report: "SC", store: "1" });
		expect(text(r)).toContain("CASEY CASHIER");
		await b.key("PF3");
		r = await b.key("ENTER", { report: "SH", store: "1" });
		expect(text(r)).toContain("*");
		await b.key("PF3");
		r = await b.key("ENTER", { report: "SX", store: "1" });
		expect(text(r)).toContain("POST-VOIDS: 0");
		await b.key("PF3");
		r = await b.key("ENTER", { report: "IL", store: "1" });
		expect(text(r)).toContain("MUG, STONEWARE");
		await b.key("PF3");
		r = await b.key("ENTER", { report: "IV", store: "1" });
		expect(text(r)).toContain("INVENTORY VALUE BY DEPARTMENT");

		// Printed: a PDF the same user can fetch.
		r = await b.key("PF10");
		expect(text(r)).toContain("POS6111I");
		const dl = (r as { download?: { url: string; name: string } }).download!;
		expect(dl.url).toMatch(/^\/v1\/report\.pdf\?r=IV/);
		const res = await app.request(dl.url, {}, { ...env, DEV_USER: "ADMIN" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		const body = new TextDecoder().decode(await res.arrayBuffer());
		expect(body.startsWith("%PDF-1.4")).toBe(true);
		expect(body).toContain("(INVENTORY VALUE BY DEPARTMENT");
		expect(body.trimEnd().endsWith("%%EOF")).toBe(true);
		// A manager of store 2 can't print store 1's.
		const res2 = await app.request(dl.url, {}, { ...env, DEV_USER: "MANAGER" });
		expect(res2.status).toBe(403);
		const res3 = await app.request(dl.url, {}, { ...env, DEV_USER: "CASHIER" });
		expect(res3.status).toBe(403);
	});
});
