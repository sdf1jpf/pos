import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text, value } from "./terminal";

describe("clerks signed on through Access", () => {
	it("start their own register without an operator ID or PIN", async () => {
		const t = terminal("CASHIER");
		let r = await t.key("START");
		expect(map(r)).toBe("POS201");
		expect(text(r)).toContain("CASEY CASHIER, OPERATOR 3001");
		expect(value(r, "store")).toBe("1"); // the one store Casey works at
		r = await t.key("ENTER", { store: "2", reg: "1" });
		expect(text(r)).toContain("POS2002E YOU MAY NOT OPEN REGISTERS IN STORE 2");
		r = await t.key("ENTER", { store: "1", reg: "9" });
		expect(text(r)).toContain("POS2004E");
		r = await t.key("ENTER", { store: "1", reg: "1" });
		expect(map(r)).toBe("POS210");
		expect(text(r)).toContain("ENTER SIGNS YOU ON");
		expect(r.screen!.fields.some((f) => f.name === "pin")).toBe(false);

		// The time clock, then signing on.
		r = await t.key("PF9");
		expect(text(r)).toContain("POS2112I CASEY CASHIER CLOCKED IN");
		r = await t.key("ENTER");
		expect(map(r)).toBe("POS211");
		r = await t.key("PF10", { "n:20": "5" });
		expect(map(r)).toBe("POS220");
		const signon = await env.DB.prepare("SELECT userid, detail FROM audit WHERE action = 'REG.SIGNON' ORDER BY id DESC").first();
		expect(signon).toEqual({ userid: "OP3001", detail: "through Access as CASHIER" });

		// Signing off goes back to their sign-on screen, and PF3 there to
		// pick another register.
		await t.key("PF4");
		r = await t.key("ENTER", { option: "6" });
		expect(map(r)).toBe("POS210");
		expect(text(r)).toContain("SIGNED OFF");
		r = await t.key("PF3");
		expect(map(r)).toBe("POS201");
		r = await t.key("PF3");
		expect(r.logoff).toBeDefined();

		// A cashier made inactive can't go on.
		const u = terminal("CASHIER");
		await u.key("START");
		await env.DB.prepare("UPDATE employees SET status = 'I' WHERE userid = 'CASHIER'").run();
		r = await u.key("ENTER", { store: "1", reg: "1" });
		expect(r.logoff?.message).toContain("POS2114E CASHIER MAY NOT RUN A REGISTER");
	});
});
