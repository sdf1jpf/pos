import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text, value } from "./terminal";

describe("customers, cards, the audit log and reason codes", () => {
	it("keeps the customer file", async () => {
		const a = terminal("MANAGER");
		await a.key("START");
		let r = await a.key("ENTER", { option: "7.1" });
		expect(map(r)).toBe("POS710");
		expect(text(r)).toContain("NO CUSTOMERS YET");
		r = await a.key("PF5");
		expect(map(r)).toBe("POS711");
		r = await a.key("ENTER", { name: "dana lee", phone: "555 1234" });
		expect(text(r)).toContain("POS7114E PHONE IS 10 DIGITS");
		r = await a.key("ENTER", { name: "dana lee", phone: "(555) 123-4567", exempt: "Y" });
		expect(text(r)).toContain("CERTIFICATE NUMBER");
		r = await a.key("ENTER", { name: "dana lee", phone: "(555) 123-4567", exempt: "N" });
		expect(text(r)).toMatch(/POS7113I CUSTOMER \d+ ADDED/);
		expect(value(r, "phone")).toBe("555-123-4567");
		r = await a.key("ENTER", { email: "dana@example.com", exempt: "Y", exemptId: "tx-889" });
		expect(text(r)).toMatch(/POS7112I CUSTOMER \d+ UPDATED/);
		expect(text(r)).toContain("VERSION 2");
		await a.key("PF3");
		r = await a.key("ENTER", { q: "4567" });
		expect(text(r)).toContain("DANA LEE");
		r = await a.key("ENTER", { q: "nobody" });
		expect(text(r)).toContain("NO CUSTOMER MATCHES");
		const c = await env.DB.prepare("SELECT name, phone, email, tax_exempt, exempt_id FROM customers").first();
		expect(c).toEqual({ name: "DANA LEE", phone: "5551234567", email: "dana@example.com", tax_exempt: 1, exempt_id: "TX-889" });
	});

	it("adjusts and stops gift cards with a reason", async () => {
		await env.DB.prepare("INSERT INTO cards (number, kind, balance, issued_at, updated_at) VALUES ('60001234', 'GIFT', 2500, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')").run();
		const a = terminal("MANAGER");
		await a.key("START");
		let r = await a.key("ENTER", { option: "7.2" });
		expect(map(r)).toBe("POS720");
		r = await a.key("ENTER", { card: "9999-9999" });
		expect(text(r)).toContain("POS7202E CARD 99999999 NOT FOUND");
		r = await a.key("ENTER", { card: "6000-1234" });
		expect(text(r)).toContain("BALANCE 25.00");
		expect(text(r)).toContain("CO=CORRECTION");
		r = await a.key("ENTER", { amount: "-30.00", reason: "CO" });
		expect(text(r)).toContain("BELOW 0.00");
		r = await a.key("ENTER", { amount: "-5.00", reason: "XX" });
		expect(text(r)).toContain("REASON MUST BE CO, GW, OT");
		r = await a.key("ENTER", { amount: "-5.00", reason: "co" });
		expect(text(r)).toContain("POS7205I CARD 60001234 BALANCE NOW 20.00");
		expect(text(r)).toContain("MANAGER");
		r = await a.key("PF11");
		expect(text(r)).toContain("STOPPED - CAN'T BE SPENT");
		expect(await env.DB.prepare("SELECT balance, status FROM cards WHERE number = '60001234'").first()).toEqual({ balance: 2000, status: "I" });
		expect(await env.DB.prepare("SELECT amount, userid, reason FROM card_moves WHERE card = '60001234'").first()).toEqual({ amount: -500, userid: "MANAGER", reason: "CO" });
	});

	it("keeps reason codes the screens use", async () => {
		const a = terminal("ADMIN");
		await a.key("START");
		let r = await a.key("ENTER", { option: "8.4" });
		expect(map(r)).toBe("POS840");
		expect(text(r)).toContain("SHRINK");
		r = await a.key("ENTER", { "status:US": "I", "code:new": "TH", "desc:new": "theft" });
		expect(text(r)).toContain("POS8403I 2 CODE(S) SAVED");
		r = await a.key("ENTER", { "code:new": "DM", "desc:new": "again" });
		expect(text(r)).toContain("DM IS ALREADY A CODE");
		r = await a.key("ENTER", { kind: "override" });
		expect(text(r)).toContain("PRICE MATCH");
		await a.key("PF3");

		// Stock adjustments take the new code, and not the one made inactive.
		r = await a.key("ENTER", { option: "2.2" });
		expect(text(r)).toContain("TH=THEFT");
		expect(text(r)).not.toContain("US=STORE USE");
		r = await a.key("ENTER", { store: "1", sku: "300100", qty: "-1", reason: "US" });
		expect(text(r)).toContain("REASON MUST BE DM, FD, OT, SH, TH");
		r = await a.key("ENTER", { store: "1", sku: "300100", qty: "-1", reason: "TH" });
		expect(text(r)).toContain("ADJUSTED");
	});

	it("shows the audit log, limited to a manager's stores", async () => {
		const a = terminal("ADMIN");
		await a.key("START");
		await a.key("ENTER", { option: "2.2" });
		await a.key("ENTER", { store: "1", sku: "300100", qty: "-1", reason: "DM" });
		await a.key("ENTER", { store: "2", sku: "300100", qty: "2", reason: "FD" });
		await a.key("PF3");
		let r = await a.key("ENTER", { option: "8.3" });
		expect(map(r)).toBe("POS830");
		r = await a.key("ENTER", { action: "stock" });
		expect(text(r)).toContain("ROW 1 TO 3 OF 3"); // and the one in the test before
		const id = (await env.DB.prepare("SELECT id FROM audit WHERE action = 'STOCK.ADJUST' AND detail LIKE '%reason=DM'").first<{ id: number }>())!.id;
		r = await a.key("ENTER", { [`sel:${id}`]: "S" });
		expect(map(r)).toBe("POS831");
		expect(text(r)).toContain("qty=-1000 reason=DM");
		await a.key("PF3");
		r = await a.key("ENTER", { before: "2020-01-01" });
		expect(text(r)).toContain("NOTHING MATCHES");

		const m = terminal("MANAGER");
		await m.key("START");
		r = await m.key("ENTER", { option: "8" });
		expect(text(r)).toContain("AUDIT LOG");
		expect(text(r)).not.toContain("REASON CODES");
		r = await m.key("ENTER", { option: "3" });
		r = await m.key("ENTER", { action: "STOCK" });
		expect(text(r)).toContain("ROW 1 TO 1 OF 1");
		r = await m.key("ENTER", { store: "1" });
		expect(text(r)).toContain("POS8301E YOU MAY NOT WORK ON STORE 1");
		r = await m.key("ENTER", { store: "", action: "STOCK" });
		expect(text(r)).not.toContain("reason=DM");
	});
});
