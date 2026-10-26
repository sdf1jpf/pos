import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SPAN } from "../src/data/db";
import { receiptNo } from "../src/register/receipt";
import { readReceipt } from "../src/register/returns";
import { map, terminal, text, type Reply } from "./terminal";

// Ids by site and the change log, the groundwork of in-store mode.

async function lane(reg: string) {
	const t = terminal("SUPER");
	await t.key("START");
	await t.key("ENTER", { option: "R" });
	await t.key("ENTER", { store: "1", reg });
	let r = await t.key("ENTER", { operator: "3001", pin: "1234" });
	if (map(r) === "POS211") r = await t.key("PF10", { "n:20": "5" });
	expect(map(r)).toBe("POS220");
	return t;
}

async function ring(t: ReturnType<typeof terminal>): Promise<Reply> {
	await t.key("ENTER", { item: "300100" });
	await t.key("PF5");
	const r = await t.key("ENTER", { method: "C", amount: "20" });
	expect(text(r)).toContain("POS2312I");
	await t.key("ENTER");
	return r;
}

const logged = async (tbl: string) =>
	(await env.DB.prepare("SELECT key FROM changes WHERE tbl = ? ORDER BY rev").bind(tbl).all<{ key: string }>()).results.map((r) => r.key);

describe("receipt numbers", () => {
	it("mark a sale rung on a store server with L", () => {
		expect(receiptNo({ store: 1, reg: 2, id: 123 })).toBe("1-02-000123");
		expect(receiptNo({ store: 1, reg: 2, id: SPAN + 123 })).toBe("1-02-L000123");
		expect(readReceipt("1-02-000123")).toBe(123);
		expect(readReceipt("*1-02-L000123*")).toBe(SPAN + 123);
		expect(readReceipt("3-01-l000007")).toBe(3 * SPAN + 7);
		expect(readReceipt("L7", 2)).toBe(2 * SPAN + 7);
		expect(readReceipt("L7")).toBeUndefined();
		expect(readReceipt("42")).toBe(42);
	});
});

describe("the cloud", () => {
	it("logs master data, the seed included, and not what the registers write", async () => {
		expect(await logged("items")).toContain('["300100"]');
		const before = (await logged("items")).length;
		await env.DB.prepare("UPDATE items SET descr = descr WHERE sku = '300100'").run();
		expect((await logged("items")).length).toBe(before + 1);

		const t = await lane("1");
		await ring(t);
		const sale = await env.DB.prepare("SELECT MAX(id) AS id FROM sales").first<{ id: number }>();
		expect(sale!.id).toBeLessThan(SPAN);
		expect(await logged("sales")).toEqual([]);
		expect(await logged("audit")).toEqual([]);
	});
});

describe("a store server", () => {
	it("numbers what its registers write from its own range, and logs it to send up", async () => {
		await env.DB.prepare("UPDATE site SET base = ?").bind(SPAN).run();
		const before = (await logged("items")).length;
		await env.DB.prepare("UPDATE items SET descr = descr WHERE sku = '300100'").run();
		expect((await logged("items")).length).toBe(before);

		const t = await lane("2");
		const r = await ring(t);
		expect(text(r)).toContain("SALE L1 COMPLETE");
		const ids = await env.DB.prepare("SELECT id FROM sales WHERE id > ? ORDER BY id").bind(SPAN).all<{ id: number }>();
		expect(ids.results.map((x) => x.id)).toEqual([SPAN + 1]);
		expect(await logged("sales")).toEqual([`[${SPAN + 1}]`]);
		expect(await logged("sale_lines")).toEqual([`[${SPAN + 1},1]`]);
		expect((await logged("audit")).length).toBeGreaterThan(0);
		const drawer = await env.DB.prepare("SELECT drawer FROM sales WHERE id = ?").bind(SPAN + 1).first<{ drawer: number }>();
		expect(drawer!.drawer).toBe(SPAN + 1); // its drawer too

		// The receipt comes back by its L number.
		await t.key("PF4");
		let x = await t.key("ENTER", { option: "8" });
		expect(map(x)).toBe("POS232");
		x = await t.key("ENTER", { receipt: "1-02-L000001" });
		expect(text(x)).toContain("POS2328I");
		x = await t.key("ENTER", { receipt: "1-02-L000002" });
		expect(text(x)).toContain("POS2326E RECEIPT 1-02-L000002 NOT FOUND");
		await env.DB.prepare("UPDATE site SET base = 0").run();
	});
});
