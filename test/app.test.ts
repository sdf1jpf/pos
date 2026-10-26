import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { map, terminal, text, value } from "./terminal";

describe("sign-on", () => {
	it("names itself for the clients", async () => {
		const info = await (await app.request("/v1/screen/info", {}, env)).json();
		expect(info).toMatchObject({ title: "POINT OF SALE", prefix: "POS", system: "POS1" });
	});

	it("turns away people who are not on file and cashiers", async () => {
		for (const user of ["STRANGER", "CASHIER"]) {
			const r = await terminal(user).key("START");
			expect(r.logoff?.message).toContain(`POS0001E ${user} IS NOT AUTHORIZED FOR THE BACK OFFICE`);
		}
	});

	it("shows each role only its options", async () => {
		const options = async (user: string) => {
			const r = await terminal(user).key("START");
			expect(map(r)).toBe("POSM00");
			return r.screen!.fields.filter((f) => f.row >= 6 && f.col === 7).map((f) => f.text);
		};
		expect(await options("ADMIN")).toEqual(["PRODUCTS", "INVENTORY", "PURCHASING", "EMPLOYEES", "END OF DAY", "ADMIN", "REGISTER", "EXIT"]);
		expect(await options("BUYER")).toEqual(["PRODUCTS", "INVENTORY", "PURCHASING", "EXIT"]);
		expect(await options("MANAGER")).toEqual(["PRODUCTS", "INVENTORY", "PURCHASING", "EMPLOYEES", "END OF DAY", "REGISTER", "EXIT"]);

		const t = terminal("MANAGER");
		await t.key("START");
		const r = await t.key("ENTER", { option: "1" });
		expect(text(r)).toContain("PRICES");
		expect(text(r)).not.toContain("ITEMS");
	});

	it("refuses a panel to someone whose role does not allow it", async () => {
		const t = terminal("BUYER");
		await t.key("START");
		let r = await t.key("ENTER", { option: "STORES" });
		expect(map(r)).toBe("POSM00");
		expect(text(r)).toContain("ISPD117E INVALID OPTION STORES");
		// A buyer who held on to an admin's screen gets nowhere with it.
		const admin = terminal("ADMIN");
		await admin.key("START");
		await admin.key("ENTER", { option: "8.1" });
		const stolen = terminal("BUYER");
		stolen.setState(admin.state());
		r = await stolen.key("ENTER");
		expect(map(r)).toBe("POSM00");
		expect(text(r)).toContain("POS0002E BUYER IS NOT AUTHORIZED");
	});
});
