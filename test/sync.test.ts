import { env } from "cloudflare:workers";
import { tokenHash } from "@greenscreen-dev/worker";
import { describe, expect, it } from "vitest";
import { SPAN } from "../src/data/db";
import { startClose } from "../src/data/endofday";
import { applyUp, changesAfter, UP } from "../src/data/sync";
import app from "../src/index";
import { syncStore, type Cloud } from "../src/sync";
import { map, terminal, text } from "./terminal";

// A store server for store 1, on its own database, and the cloud. The
// tests run in order, each going on from the last.

const SERVER = "srv1.access";
const REG = "reg2.access";
const CARD = "6000111122223333";

const store = async () => ({ ...env, DB: env.STORE_DB, STORE: "1", REGISTER_TOKENS: JSON.stringify({ [REG]: await tokenHash("pw") }) });

const online: Cloud = async (method, path, body) => {
	const res = await app.request(path, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	}, { ...env, DEV_USER: SERVER });
	if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
	return res.json();
};

const offline: Cloud = async () => {
	throw new Error("network connection lost");
};

const one = async <T>(db: D1Database, sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).first<T>())!;

describe("a store server", () => {
	it("is refused by the cloud until the store names its token", async () => {
		const r = await syncStore(await store(), online);
		expect(r.error).toContain("403");
		expect((await one<{ error: string }>(env.STORE_DB, "SELECT error FROM sync_state WHERE store = 1")).error).toContain("not a store server");
		expect((await one<{ base: number }>(env.STORE_DB, "SELECT base FROM site")).base).toBe(SPAN);
	});

	it("takes the master data its registers need: its own registers and prices only", async () => {
		await env.DB.batch([
			env.DB.prepare("UPDATE stores SET server_token = ? WHERE store = 1").bind(SERVER),
			env.DB.prepare("UPDATE registers SET token_id = ? WHERE store = 1 AND reg = 2").bind(REG),
			env.DB.prepare("INSERT INTO prices (store, sku, price, updated_at, updated_by) VALUES (2, '300100', 777, '', 'T') ON CONFLICT DO NOTHING"),
			env.DB.prepare("INSERT INTO cards (number, kind, balance, issued_at, updated_at) VALUES (?, 'GIFT', 5000, '', '')").bind(CARD),
		]);
		const r = await syncStore(await store(), online);
		expect(r.error).toBeUndefined();
		expect(r.skipped).toEqual([]);
		const count = async (db: D1Database, t: string, w = "1") => (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`)).n;
		for (const t of ["stores", "departments", "items", "employees", "employee_stores", "reason_codes", "cards"]) {
			expect(await count(env.STORE_DB, t), t).toBe(await count(env.DB, t));
		}
		expect(await count(env.STORE_DB, "registers")).toBe(await count(env.DB, "registers", "store = 1"));
		expect(await count(env.STORE_DB, "prices", "store <> 1")).toBe(0);
		expect(await count(env.STORE_DB, "stock")).toBe(await count(env.DB, "stock", "store = 1"));
		expect(await count(env.STORE_DB, "changes")).toBe(0); // nothing it was sent goes back
		expect((await one<{ balance: number }>(env.STORE_DB, "SELECT balance FROM cards WHERE number = ?", CARD)).balance).toBe(5000);
	});

	it("rings sales with the cloud cut off, and sends them up when it's back", async () => {
		const senv = await store();
		const t = terminal(REG, { env: senv, headers: { "CF-Access-Client-Id": REG, "CF-Access-Client-Secret": "pw" } });
		let r = await t.key("START");
		expect(map(r), JSON.stringify(r)).toBe("POS210");
		r = await t.key("ENTER", { operator: "3001", pin: "1234" });
		if (map(r) === "POS211") r = await t.key("PF10", { "n:20": "5" });
		expect(map(r)).toBe("POS220");
		await t.key("ENTER", { item: "300100" });
		await t.key("PF5");
		r = await t.key("ENTER", { method: "G", ref: CARD });
		expect(text(r)).toContain("SALE L1 COMPLETE");
		await t.key("ENTER");

		// The cloud is out of reach: nothing is lost, and it says why.
		let s = await syncStore(senv, offline);
		expect(s.error).toBe("network connection lost");
		const spent = 5000 - (await one<{ balance: number }>(env.STORE_DB, "SELECT balance FROM cards WHERE number = ?", CARD)).balance;
		expect(spent).toBeGreaterThan(0);

		// Meanwhile the same card is spent down in the cloud, and a price changes.
		await env.DB.batch([
			env.DB.prepare("UPDATE cards SET balance = 100 WHERE number = ?").bind(CARD),
			env.DB.prepare("INSERT INTO prices (store, sku, price, updated_at, updated_by) VALUES (1, '300100', 650, '', 'T') ON CONFLICT DO UPDATE SET price = 650"),
			env.DB.prepare("UPDATE employees SET name = name WHERE operator = 3001"),
		]);
		await env.STORE_DB.prepare("UPDATE employees SET pin_tries = 2 WHERE operator = 3001").run();

		s = await syncStore(senv, online);
		expect(s.error).toBeUndefined();
		const sale = await one<{ id: number; posted: number; total: number }>(env.DB, "SELECT id, posted, total FROM sales WHERE id = ?", SPAN + 1);
		expect(sale.posted).toBe(0); // for the cloud's sweep to post
		expect((await one<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM sale_lines WHERE sale = ?", SPAN + 1)).n).toBe(1);
		expect((await one<{ kind: string }>(env.DB, "SELECT kind FROM sale_tenders WHERE sale = ?", SPAN + 1)).kind).toBe("GIFT");
		expect((await one<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM drawers WHERE id > ?", SPAN)).n).toBe(1);
		expect((await one<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM audit WHERE id > ? AND action = 'SALE.COMPLETE'", SPAN)).n).toBe(1);
		// The card was spent twice: the cloud stops it at nothing and says so.
		expect((await one<{ balance: number }>(env.DB, "SELECT balance FROM cards WHERE number = ?", CARD)).balance).toBe(0);
		expect((await one<{ detail: string }>(env.DB, "SELECT detail FROM audit WHERE action = 'CARD.OVERDRAWN'")).detail).toContain(`amount=${-spent}`);
		// And what changed in the cloud came down, but not the PIN count.
		expect((await one<{ balance: number }>(env.STORE_DB, "SELECT balance FROM cards WHERE number = ?", CARD)).balance).toBe(0);
		expect((await one<{ price: number }>(env.STORE_DB, "SELECT price FROM prices WHERE store = 1 AND sku = '300100'")).price).toBe(650);
		expect((await one<{ pin_tries: number }>(env.STORE_DB, "SELECT pin_tries FROM employees WHERE operator = 3001")).pin_tries).toBe(2);
		expect((await one<{ n: number }>(env.STORE_DB, "SELECT COUNT(*) AS n FROM changes")).n).toBe(0);
		expect(await one<{ pushedAt: string }>(env.DB, "SELECT pushed_at AS pushedAt FROM sync_state WHERE store = 1")).toBeTruthy();
	});

	it("counts a card move sent twice once", async () => {
		await env.STORE_DB.prepare("UPDATE site SET applying = 0").run();
		await env.STORE_DB.prepare("INSERT INTO changes (tbl, key) SELECT 'card_moves', json_array(id) FROM card_moves").run();
		const again = await changesAfter(env.STORE_DB, UP, 0, 100);
		await env.DB.prepare("UPDATE cards SET balance = 2000 WHERE number = ?").bind(CARD).run();
		await applyUp(env.DB, 1, again, 99);
		expect((await one<{ balance: number }>(env.DB, "SELECT balance FROM cards WHERE number = ?", CARD)).balance).toBe(2000);
	});

	it("holds the store's day close until its server has caught up", async () => {
		await env.DB.prepare("UPDATE sync_state SET pulled_at = '2026-01-01T00:00:00Z' WHERE store = 1").run();
		await expect(startClose(env.DB, "ADMIN", 1, "2026-10-26", "wf")).rejects.toThrow("THE STORE SERVER HASN'T SYNCED SINCE 2026-01-01 00:00 UTC");
	});

	it("can't send rows that aren't its store's", async () => {
		await expect(applyUp(env.DB, 1, [{ rev: 1, tbl: "sales", key: [5], row: { id: 5, store: 1 } }], 1)).rejects.toThrow("not store 1's");
		await expect(applyUp(env.DB, 1, [{ rev: 1, tbl: "items", key: ["X"], row: { sku: "X" } }], 1)).rejects.toThrow("not sent up");
		await expect(applyUp(env.DB, 1, [{ rev: 1, tbl: "drawers", key: [SPAN + 9], row: { id: SPAN + 9, "store; DROP": 1 } }], 1)).rejects.toThrow("bad column");
		const res = await app.request("/v1/sync?since=0", {}, { ...env, DEV_USER: "SOMEONE" });
		expect(res.status).toBe(403);
	});
});
