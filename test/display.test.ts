import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { View } from "../src/display";
import { map, terminal, text } from "./terminal";

const e = { ...env, DEV_USER: "NOBODY" };
const call = (path: string, init: RequestInit = {}) => app.request(path, init, e);

// A display's WebSocket, and the views it has been sent.
async function socket(token: string) {
	const res = await call(`/v1/display/ws?t=${encodeURIComponent(token)}`, { headers: { Upgrade: "websocket" } });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	const views: View[] = [];
	let waiting: (() => void) | undefined;
	let closed: number | undefined;
	ws.addEventListener("message", (m) => {
		views.push(JSON.parse(m.data as string));
		waiting?.();
	});
	ws.addEventListener("close", (c) => {
		closed = c.code;
		waiting?.();
	});
	ws.accept();
	// next waits for a view that passes test.
	async function next(test: (v: View) => boolean): Promise<View> {
		for (let i = 0; i < 50; i++) {
			const v = views.find(test);
			if (v) {
				views.splice(0, views.indexOf(v) + 1);
				return v;
			}
			await new Promise<void>((r) => {
				waiting = r;
				setTimeout(r, 100);
			});
		}
		throw new Error(`no such view; have ${JSON.stringify(views)}`);
	}
	return { next, closed: () => closed, close: () => ws.close() };
}

describe("the customer display", () => {
	it("pairs by code, follows the sale and unpairs", async () => {
		const page = await call("/display");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Customer display");

		const made = await call("/v1/display", { method: "POST" });
		expect(made.status).toBe(201);
		const { token, code } = (await made.json()) as { token: string; code: string };
		expect(code).toMatch(/^\d{6}$/);
		const auth = { headers: { Authorization: `Bearer ${token}` } };
		expect(await (await call("/v1/display", auth)).json()).toEqual({ paired: false, code });
		expect((await call("/v1/display", { headers: { Authorization: "Bearer nonsense" } })).status).toBe(401);
		expect((await call(`/v1/display/ws?t=${token}`, { headers: { Upgrade: "websocket" } })).status).toBe(409);

		// A supervisor opens register 1 and a cashier rings an item.
		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "1", reg: "1" });
		let r = await t.key("ENTER", { operator: "3001", pin: "1234" });
		r = await t.key("PF10", { "n:20": "5" });
		expect(map(r)).toBe("POS220");
		await t.key("ENTER", { item: "300100", qty: "2" });

		// Pairing, from the functions.
		await t.key("PF4");
		r = await t.key("ENTER", { option: "12" });
		expect(map(r)).toBe("POS238");
		expect(text(r)).toContain("NO DISPLAY IS PAIRED");
		r = await t.key("ENTER", { code: "12345" });
		expect(text(r)).toContain("POS2381E");
		r = await t.key("ENTER", { code: code === "000000" ? "000001" : "000000" });
		expect(text(r)).toContain("POS2382E");
		r = await t.key("ENTER", { code });
		expect(map(r)).toBe("POS220");
		expect(text(r)).toContain("POS2380I CUSTOMER DISPLAY PAIRED TO REGISTER 1");
		expect(await (await call("/v1/display", auth)).json()).toMatchObject({ paired: true, store: 1, reg: 1, name: "FRONT LANE 1" });
		const audit = await env.DB.prepare("SELECT action FROM audit WHERE action LIKE 'REG.DISPLAY%'").all();
		expect(audit.results).toEqual([{ action: "REG.DISPLAY.PAIR" }]);

		// It is sent the sale as it stands, then each change.
		const ws = await socket(token);
		let v = await ws.next((v) => v.v === "sale");
		expect(v).toMatchObject({ v: "sale", cashier: "Casey", subtotal: "11.98", total: "12.85", lines: [{ desc: "MUG, STONEWARE 12 OZ", qty: "2", price: "5.99", amount: "11.98" }] });
		await t.key("ENTER", { item: "100100" });
		v = await ws.next((v) => v.v === "sale" && v.lines.length === 2);
		if (v.v !== "sale") throw new Error();
		expect(v.lines[1]).toMatchObject({ amount: expect.any(String) });
		expect(v.lines[1].qty).toBeUndefined();

		// The card terminal's prompt, then the change.
		r = await t.key("PF5");
		r = await t.key("ENTER", { method: "D", amount: "5" });
		expect(map(r)).toBe("POS231");
		v = await ws.next((v) => v.v === "sale" && !!v.card);
		expect(v).toMatchObject({ card: { amount: "5.00", refund: false } });
		r = await t.key("ENTER");
		v = await ws.next((v) => v.v === "sale" && v.tenders.length === 1 && !v.card);
		expect(v).toMatchObject({ paid: "5.00" });
		r = await t.key("ENTER", { method: "C", amount: "20" });
		expect(map(r)).toBe("POS240");
		v = await ws.next((v) => v.v === "done");
		expect(v).toMatchObject({ v: "done", receipt: "1-01-000001" });
		if (v.v !== "done") throw new Error();
		expect(Number(v.change)).toBeGreaterThan(0);
		await t.key("ENTER");
		await ws.next((v) => v.v === "idle");

		// Unpaired, it is cut off and forgotten.
		await t.key("PF4");
		r = await t.key("ENTER", { option: "12" });
		expect(text(r)).toContain("DISPLAYS PAIRED TO THIS REGISTER: 1");
		r = await t.key("PF6");
		expect(text(r)).toContain("POS2384I 1 DISPLAY UNPAIRED");
		for (let i = 0; i < 20 && ws.closed() === undefined; i++) await new Promise((res) => setTimeout(res, 50));
		expect(ws.closed()).toBe(4001);
		expect((await call("/v1/display", auth)).status).toBe(401);
	});

	it("shows a register closed once its operator signs off", async () => {
		const { token, code } = (await (await call("/v1/display", { method: "POST" })).json()) as { token: string; code: string };
		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		await t.key("ENTER", { store: "1", reg: "2" });
		await t.key("ENTER", { operator: "3002", pin: "1234" });
		await t.key("PF10", { "n:20": "5" });
		await t.key("PF4");
		await t.key("ENTER", { option: "12" });
		await t.key("ENTER", { code });
		const ws = await socket(token);
		await ws.next((v) => v.v === "idle");
		const r = await t.key("PF3");
		expect(map(r)).toBe("POS210");
		await ws.next((v) => v.v === "closed");
		ws.close();
	});
});
