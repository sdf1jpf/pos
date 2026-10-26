import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { map, terminal, text } from "./terminal";

// A supervisor opens a register from the back office and a cashier signs on.
async function lane(user: string, reg: string, operator: string, store = "1") {
	const t = terminal(user);
	await t.key("START");
	let r = await t.key("ENTER", { option: "R" });
	expect(map(r)).toBe("POS200");
	r = await t.key("ENTER", { store, reg });
	expect(map(r)).toBe("POS210");
	r = await t.key("ENTER", { operator, pin: "1234" });
	return { t, r };
}

describe("a sale", () => {
	it("rings, voids, splits a tender, prints a receipt and balances the drawer", async () => {
		const { t, r: first } = await lane("SUPER", "1", "3001");
		expect(map(first)).toBe("POS211");
		let r = await t.key("ENTER", { "n:20": "5", "n:1": "10" });
		expect(text(r)).toContain("110.00");
		r = await t.key("PF10");
		expect(map(r)).toBe("POS220");
		expect(text(r)).toMatch(/POS2111I DRAWER \d+ OPENED/);

		r = await t.key("ENTER", { item: "300100", qty: "2" });
		expect(text(r)).toContain("POS2210I MUG, STONEWARE 12 OZ 2 @ 5.99 = 11.98");
		r = await t.key("ENTER", { item: "200100" });
		expect(text(r)).toContain("POS2207E");
		r = await t.key("ENTER", { item: "200100", qty: "1.5" });
		expect(text(r)).toContain("= 2.99");
		r = await t.key("ENTER", { item: "100100" });
		r = await t.key("ENTER", { item: "NOSUCH" });
		expect(text(r)).toContain("POS2203E ITEM NOSUCH NOT FOUND");
		r = await t.key("PF2", { item: "012345678912" });
		expect(text(r)).toContain("POS2205I 100200 PASTA, SPAGHETTI 1 LB 1.49");
		expect(text(r)).toContain("TOTAL      23.83");
		r = await t.key("PF6", { line: "3" });
		expect(text(r)).toContain("POS2215I LINE 3 VOIDED");
		expect(text(r)).toContain("TOTAL      15.84");

		r = await t.key("PF5");
		expect(map(r)).toBe("POS230");
		r = await t.key("ENTER", { method: "D", amount: "10" });
		expect(map(r)).toBe("POS231");
		expect(text(r)).toContain("CHARGE TO CARD");
		expect(text(r)).toContain("INSERT, TAP OR SWIPE CARD");
		r = await t.key("PF3");
		expect(map(r)).toBe("POS230");
		expect(text(r)).toContain("POS2307W CARD CANCELLED");
		r = await t.key("ENTER", { method: "D", amount: "10" });
		r = await t.key("PF10");
		expect(map(r)).toBe("POS230");
		expect(text(r)).toMatch(/POS2340E \w+ \*{4}\d{4} DECLINED - /);
		expect(text(r)).toContain("BALANCE DUE|     15.84");
		r = await t.key("ENTER", { method: "D", amount: "10" });
		r = await t.key("ENTER");
		expect(map(r)).toBe("POS230");
		expect(text(r)).toContain("POS2311I CARD 10.00 APPLIED - 5.84 STILL DUE");
		r = await t.key("ENTER", { method: "C", amount: "20" });
		expect(map(r)).toBe("POS240");
		expect(text(r)).toMatch(/POS2312I SALE \d+ COMPLETE - CHANGE DUE 14.16/);
		expect(text(r)).toContain("1-01-000001");
		const rest = await t.key("PF8");
		expect(text(rest)).toMatch(/CARD \*{4}\d{4} AUTH [A-Z0-9]{6}/);
		expect(text(rest)).toContain("*1-01-000001*");
		const id = Number(/SALE (\d+) COMPLETE/.exec(text(r))![1]);
		const sale = await env.DB.prepare("SELECT total, tax, change, status FROM sales WHERE id = ?").bind(id).first();
		expect(sale).toEqual({ total: 1584, tax: 87, change: 1416, status: "C" });
		const audit = await env.DB.prepare("SELECT action FROM audit WHERE subject = ? ORDER BY id").bind(String(id)).all();
		expect(audit.results.map((a) => a.action)).toEqual(["SALE.LINEVOID", "SALE.COMPLETE"]);

		// Next sale: scanned, then voided whole.
		r = await t.key("ENTER");
		expect(map(r)).toBe("POS220");
		r = await t.key("ENTER", { item: "012345678912" });
		expect(text(r)).toContain("PASTA");
		r = await t.key("PF3");
		expect(text(r)).toContain("POS2219E FINISH OR VOID THE SALE FIRST");
		r = await t.key("PF12");
		expect(text(r)).toContain("POS2216W");
		r = await t.key("PF12");
		expect(text(r)).toMatch(/POS2217I SALE \d+ VOIDED/);

		// Paid out, no sale, and close: the drawer should hold
		// 110.00 + 5.84 cash - 5.00 paid out.
		r = await t.key("PF4");
		expect(map(r)).toBe("POS225");
		r = await t.key("ENTER", { option: "3" });
		r = await t.key("ENTER", { amount: "5", reason: "window cleaner" });
		expect(text(r)).toContain("POS2602I PAID OUT 5.00 RECORDED");
		await t.key("PF4");
		r = await t.key("ENTER", { option: "4" });
		expect(text(r)).toContain("POS2251I DRAWER OPENED - NO SALE");
		await t.key("PF4");
		r = await t.key("ENTER", { option: "5" });
		expect(map(r)).toBe("POS250");
		expect(text(r)).not.toContain("110.84");
		r = await t.key("PF10", { "n:20": "5", "n:1": "10", "n:.25": "3", "n:.05": "1", "n:.01": "3" });
		expect(text(r)).toMatch(/POS2504W DRAWER \d+ CLOSED - SHORT 0.01/);
		expect(text(r)).toContain("110.84");
		r = await t.key("ENTER");
		expect(map(r)).toBe("POS210");
		expect(text(r)).toContain("POS2110I CASEY CASHIER SIGNED OFF");
	});
});

describe("sign-on", () => {
	it("locks an operator out after three wrong PINs until a new one is set", async () => {
		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "1", reg: "2" });
		let r = await t.key("ENTER", { operator: "3002", pin: "1111" });
		expect(text(r)).toContain("POS2104E OPERATOR ID OR PIN IS WRONG - 2 TRIES LEFT");
		r = await t.key("ENTER", { operator: "3002", pin: "1111" });
		r = await t.key("ENTER", { operator: "3002", pin: "1111" });
		expect(text(r)).toContain("POS2105E OPERATOR 3002 IS LOCKED OUT");
		r = await t.key("ENTER", { operator: "3002", pin: "1234" });
		expect(text(r)).toContain("POS2105E");

		const admin = terminal("ADMIN");
		await admin.key("START");
		await admin.key("ENTER", { option: "4.1" });
		r = await admin.key("ENTER", { "sel:5": "S" });
		expect(text(r)).toContain("LOCKED OUT");
		r = await admin.key("ENTER", { pin: "4321" });
		expect(text(r)).toContain("POS0403I EMPLOYEE 5 UPDATED");
		expect(text(r)).toContain("SET - 4 DIGITS");

		r = await t.key("ENTER", { operator: "3002", pin: "4321" });
		expect(map(r)).toBe("POS211");
		// Signing off and leaving lets another terminal have the register.
		r = await t.key("PF3");
		r = await t.key("PF3");
		expect(map(r)).toBe("POSM00");
	});

	it("keeps operators to their stores and a register to one terminal", async () => {
		const t = terminal("ADMIN");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "2", reg: "1" });
		let r = await t.key("ENTER", { operator: "3001", pin: "1234" });
		expect(text(r)).toContain("POS2107E OPERATOR 3001 MAY NOT SIGN ON IN STORE 2");

		const other = terminal("MANAGER");
		await other.key("START");
		await other.key("ENTER", { option: "R" });
		r = await other.key("ENTER", { store: "2", reg: "1" });
		expect(map(r)).toBe("POS200");
		expect(text(r)).toContain("POS1201E RECORD IN USE BY ADMIN");
		r = await other.key("ENTER", { store: "1", reg: "1" });
		expect(text(r)).toContain("POS2002E YOU MAY NOT OPEN REGISTERS IN STORE 1");
		await t.key("PF3");
	});

	it("signs an enrolled register straight on to its lane", async () => {
		const token = "0123456789abcdef0123456789abcdef";
		const admin = terminal("ADMIN");
		await admin.key("START");
		await admin.key("ENTER", { option: "8.2" });
		await admin.key("ENTER", { store: "2" });
		let r = await admin.key("ENTER", { "tok:1": token });
		expect(text(r)).toContain("POS0810I 1 REGISTER(S) SAVED FOR STORE 2");

		const device = terminal(`${token}.access`);
		r = await device.key("START");
		expect(map(r)).toBe("POS210");
		expect(text(r)).toContain("STORE 2");
		r = await device.key("ENTER", { operator: "2001", pin: "1234" });
		expect(map(r)).toBe("POS211");
		r = await device.key("PF3");
		expect(map(r)).toBe("POS210");
		r = await device.key("PF3");
		expect(r.logoff?.message).toContain("LOGGED OFF");

		const stranger = terminal("ffffffffffffffffffffffffffffffff.access");
		r = await stranger.key("START");
		expect(r.logoff?.message).toContain("POS0001E");
	});
});

describe("a post-void", () => {
	it("needs a supervisor's PIN and takes the sale out of the drawer", async () => {
		const { t } = await lane("SUPER", "2", "3001");
		await t.key("ENTER", { "n:20": "2" });
		let r = await t.key("PF10");
		r = await t.key("ENTER", { item: "400100" });
		await t.key("PF5");
		r = await t.key("ENTER", { method: "C", amount: "30" });
		const id = Number(/SALE (\d+) COMPLETE/.exec(text(r))![1]);
		await t.key("ENTER");
		await t.key("PF4");
		r = await t.key("ENTER", { option: "1" });
		expect(map(r)).toBe("POS241");
		r = await t.key("ENTER", { [`sel:${id}`]: "V" });
		expect(map(r)).toBe("POS290");
		r = await t.key("ENTER", { operator: "3001", pin: "1234" });
		expect(text(r)).toContain("POS2905E CASEY CASHIER MAY NOT APPROVE THIS");
		r = await t.key("ENTER", { operator: "4001", pin: "9999" });
		expect(text(r)).toContain("POS2904E");
		r = await t.key("ENTER", { operator: "4001", pin: "1234" });
		expect(map(r)).toBe("POS241");
		expect(text(r)).toContain(`POS2907I SALE ${id} VOIDED - APPROVED BY SAM SUPERVISOR`);
		expect(text(r)).toContain("VOIDED");
		const row = await env.DB.prepare("SELECT status, void_approver FROM sales WHERE id = ?").bind(id).first();
		expect(row).toEqual({ status: "V", void_approver: 4 });
		const a = await env.DB.prepare("SELECT approver FROM audit WHERE action = 'SALE.POSTVOID' AND subject = ?").bind(String(id)).first();
		expect(a).toEqual({ approver: "OP4001" });
		await t.key("ENTER", { [`sel:${id}`]: "S" });
		r = await t.key("PF8");
		expect(text(r)).toContain("*** VOIDED");

		// The drawer holds only its float again.
		await t.key("ENTER");
		await t.key("PF3");
		await t.key("PF4");
		await t.key("ENTER", { option: "5" });
		r = await t.key("PF10", { "n:20": "2" });
		expect(text(r)).toContain("IN BALANCE");
	});
});
