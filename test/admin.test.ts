import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text, value } from "./terminal";

async function at(user: string, option: string) {
	const t = terminal(user);
	await t.key("START");
	const r = await t.key("ENTER", { option });
	return { t, r };
}

const blankStore = { store: "", name: "", addr1: "", addr2: "", city: "", state: "", zip: "", phone: "", taxRate: "", discountLimit: "", header1: "", header2: "", footer1: "", footer2: "", status: "" };

describe("stores", () => {
	it("adds a store, checking its fields", async () => {
		const { t, r } = await at("ADMIN", "8.1");
		expect(map(r)).toBe("POS810");
		expect(text(r)).toContain("MAIN STREET");
		await t.key("PF5");
		let s = await t.key("ENTER", { ...blankStore, store: "3", name: "Uptown", state: "Ohio" });
		expect(text(s)).toContain("POS0805E STATE MUST BE TWO LETTERS");
		s = await t.key("ENTER", { ...blankStore, store: "3", name: "Uptown", state: "oh", taxRate: "31" });
		expect(text(s)).toContain("TAX RATE MUST BE A PERCENTAGE");
		s = await t.key("ENTER", { ...blankStore, store: "3", name: "Uptown", state: "oh", taxRate: "6.125" });
		expect(text(s)).toContain("POS0804I STORE 3 ADDED");
		expect(value(s, "taxRate")).toBe("6.125");
		const row = await env.DB.prepare("SELECT tax_rate, state FROM stores WHERE store = 3").first();
		expect(row).toEqual({ tax_rate: 6125, state: "OH" });
		await t.key("PF3");
		await t.key("PF5");
		s = await t.key("ENTER", { ...blankStore, store: "1", name: "Again" });
		expect(text(s)).toContain("STORE 1 ALREADY EXISTS");
	});

	it("updates a store", async () => {
		const { t } = await at("ADMIN", "8.1");
		let r = await t.key("ENTER", { "sel:2": "S" });
		expect(map(r)).toBe("POS811");
		expect(value(r, "taxRate")).toBe("7.50");
		r = await t.key("ENTER", { footer2: "OPEN 7 DAYS" });
		expect(text(r)).toContain("POS0803I STORE 2 UPDATED");
		expect(value(r, "footer2")).toBe("OPEN 7 DAYS");
	});

	it("keeps registers by store", async () => {
		const { t } = await at("ADMIN", "8.1");
		let r = await t.key("ENTER", { "sel:1": "R" });
		expect(map(r)).toBe("POS820");
		expect(value(r, "name:2")).toBe("FRONT LANE 2");
		r = await t.key("ENTER", { reg: "3", name: "self checkout" });
		expect(text(r)).toContain("POS0810I 1 REGISTER(S) SAVED FOR STORE 1");
		expect(value(r, "name:3")).toBe("SELF CHECKOUT");
		r = await t.key("ENTER", { "st:2": "I" });
		expect(value(r, "st:2")).toBe("I");
		r = await t.key("ENTER", { reg: "1", name: "dup" });
		expect(text(r)).toContain("REGISTER 1 ALREADY EXISTS IN STORE 1");
		r = await t.key("ENTER", { store: "9" });
		expect(text(r)).toContain("POS0807E STORE 9 NOT FOUND");
	});
});

describe("employees", () => {
	it("adds an employee who can then sign on with their role", async () => {
		const { t, r } = await at("ADMIN", "4");
		expect(map(r)).toBe("POS410");
		expect(text(r)).toContain("PAT BUYER");
		await t.key("PF5");
		const typed = { name: "Lee Admin", role: "boss", userid: "LEE", operator: "", stores: "", status: "A" };
		let s = await t.key("ENTER", typed);
		expect(text(s)).toContain("POS0405E ROLE MUST BE");
		s = await t.key("ENTER", { ...typed, role: "admin", stores: "1,7" });
		expect(text(s)).toContain("STORE 7 NOT FOUND");
		s = await t.key("ENTER", { ...typed, role: "admin", userid: "BUYER" });
		expect(text(s)).toContain("USERID BUYER BELONGS TO ANOTHER EMPLOYEE");
		s = await t.key("ENTER", { ...typed, role: "admin", stores: "2, 1" });
		expect(text(s)).toContain("ADDED");
		expect(value(s, "stores")).toBe("1,2");

		const lee = await terminal("LEE").key("START");
		expect(map(lee)).toBe("POSM00");
		expect(text(lee)).toContain("EMPLOYEES");
	});

	it("takes the back office away when a role changes", async () => {
		const buyer = terminal("BUYER");
		await buyer.key("START");
		await buyer.key("ENTER", { option: "1.1" });

		const { t } = await at("ADMIN", "4");
		await t.key("ENTER", { "sel:1": "S" });
		const r = await t.key("ENTER", { role: "CASHIER" });
		expect(text(r)).toContain("EMPLOYEE 1 UPDATED");

		const s = await buyer.key("ENTER", { q: "MUG" });
		expect(text(s)).toContain("POS0002E BUYER IS NOT AUTHORIZED");
		expect((await terminal("BUYER").key("START")).logoff).toBeDefined();
	});
});
