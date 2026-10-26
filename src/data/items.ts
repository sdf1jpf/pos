// The item master, departments and the store price books.

import { cents } from "../money";
import { audit, changed, Conflict, diff, Invalid, now, text, unique } from "./db";

export interface Department {
	dept: number;
	name: string;
	taxable: boolean;
	status: "A" | "I";
}

export interface Item {
	sku: string;
	upc: string; // "" when it has none
	desc: string;
	dept: number;
	class: string;
	vendor: string;
	cost: number; // cents
	price: number; // the base price, cents (per pound for a weighed item)
	taxable: boolean;
	weighed: boolean;
	status: "A" | "D";
	version: number;
	updatedAt: string;
	updatedBy: string;
}

// ItemInput is an item as typed on the screen, before it is checked.
export type ItemInput = Record<
	"sku" | "upc" | "desc" | "dept" | "class" | "vendor" | "cost" | "price" | "taxable" | "weighed" | "status",
	string
>;

// --- Departments ---

export async function listDepartments(db: D1Database): Promise<Department[]> {
	const rows = (await db.prepare("SELECT dept, name, taxable, status FROM departments ORDER BY dept")
		.all<Omit<Department, "taxable"> & { taxable: number }>()).results;
	return rows.map((r) => ({ ...r, taxable: r.taxable === 1 }));
}

function yesNo(s: string, field: string, dflt: boolean): boolean {
	const v = text(s, 1);
	if (v === "") return dflt;
	if (v !== "Y" && v !== "N") throw new Invalid(field, "TYPE Y OR N");
	return v === "Y";
}

function checkDepartment(dept: string, name: string, taxable: string, status: string): Department {
	const n = Number(dept.trim());
	if (!/^\d{1,3}$/.test(dept.trim()) || n < 1) throw new Invalid("dept", "DEPARTMENT MUST BE 1 TO 999");
	const nm = text(name, 20);
	if (!nm) throw new Invalid("name", "NAME IS REQUIRED");
	const st = text(status, 1) || "A";
	if (st !== "A" && st !== "I") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR I (INACTIVE)");
	return { dept: n, name: nm, taxable: yesNo(taxable, "taxable", true), status: st };
}

export async function addDepartment(db: D1Database, userid: string, dept: string, name: string, taxable: string): Promise<Department> {
	const d = checkDepartment(dept, name, taxable, "A");
	const at = now();
	await unique(db.batch([
		db.prepare("INSERT INTO departments (dept, name, taxable, status, updated_at, updated_by) VALUES (?, ?, ?, 'A', ?, ?)")
			.bind(d.dept, d.name, d.taxable ? 1 : 0, at, userid),
		audit(db, userid, { action: "DEPT.ADD", subject: String(d.dept), detail: d.name }, at),
	]), new Invalid("dept", `DEPARTMENT ${d.dept} ALREADY EXISTS`));
	return d;
}

export async function updateDepartment(db: D1Database, userid: string, dept: number, name: string, taxable: string, status: string): Promise<void> {
	const d = checkDepartment(String(dept), name, taxable, status);
	const at = now();
	await db.batch([
		db.prepare("UPDATE departments SET name = ?, taxable = ?, status = ?, updated_at = ?, updated_by = ? WHERE dept = ?")
			.bind(d.name, d.taxable ? 1 : 0, d.status, at, userid, dept),
		audit(db, userid, { action: "DEPT.UPDATE", subject: String(dept), detail: `name=${d.name} taxable=${d.taxable ? "Y" : "N"} status=${d.status}` }, at),
	]);
}

// --- Items ---

const COLS = `sku, COALESCE(upc, '') AS upc, descr AS "desc", dept, class, vendor, cost, price, taxable, weighed, status,
	version, updated_at AS updatedAt, updated_by AS updatedBy`;

type ItemRow = Omit<Item, "taxable" | "weighed"> & { taxable: number; weighed: number };

const fromRow = (r: ItemRow): Item => ({ ...r, taxable: r.taxable === 1, weighed: r.weighed === 1 });

export async function getItem(db: D1Database, sku: string): Promise<Item | undefined> {
	const r = await db.prepare(`SELECT ${COLS} FROM items WHERE sku = ?`).bind(sku).first<ItemRow>();
	return r ? fromRow(r) : undefined;
}

export interface ItemQuery {
	q?: string; // a SKU or UPC, the start of a SKU, or words in the description
	dept?: number;
	offset: number;
	limit: number;
}

// likeText escapes LIKE's wildcards so that typed text matches as itself.
function likeText(s: string): string {
	return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

// searchItems lists items by SKU, with how many match in all.
export async function searchItems(db: D1Database, q: ItemQuery): Promise<{ items: Item[]; total: number }> {
	const where: string[] = [];
	const args: unknown[] = [];
	const t = text(q.q, 30);
	if (t) {
		where.push("(sku LIKE ? ESCAPE '\\' OR upc = ? OR descr LIKE ? ESCAPE '\\')");
		args.push(likeText(t) + "%", t, "%" + likeText(t) + "%");
	}
	if (q.dept) {
		where.push("dept = ?");
		args.push(q.dept);
	}
	const w = where.length ? " WHERE " + where.join(" AND ") : "";
	const [rows, count] = await db.batch<ItemRow | { n: number }>([
		db.prepare(`SELECT ${COLS} FROM items${w} ORDER BY sku LIMIT ? OFFSET ?`).bind(...args, q.limit, q.offset),
		db.prepare(`SELECT COUNT(*) AS n FROM items${w}`).bind(...args),
	]);
	return { items: (rows.results as ItemRow[]).map(fromRow), total: (count.results[0] as { n: number }).n };
}

// checkItem turns what was typed into an item's fields, or throws Invalid.
export async function checkItem(db: D1Database, inp: ItemInput): Promise<Omit<Item, "version" | "updatedAt" | "updatedBy">> {
	const sku = text(inp.sku, 14);
	if (!/^[A-Z0-9][A-Z0-9-]{0,13}$/.test(sku)) throw new Invalid("sku", "SKU MUST BE 1 TO 14 LETTERS, DIGITS OR DASHES");
	const upc = inp.upc.trim();
	if (upc && !/^\d{8,14}$/.test(upc)) throw new Invalid("upc", "UPC MUST BE 8 TO 14 DIGITS");
	const desc = text(inp.desc, 30);
	if (!desc) throw new Invalid("desc", "DESCRIPTION IS REQUIRED");
	const dept = Number(inp.dept.trim());
	const d = /^\d{1,3}$/.test(inp.dept.trim())
		? await db.prepare("SELECT taxable, status FROM departments WHERE dept = ?").bind(dept).first<{ taxable: number; status: string }>()
		: null;
	if (!d) throw new Invalid("dept", "DEPARTMENT NOT FOUND - PF1 LISTS THEM");
	const cost = cents(inp.cost || "0");
	if (cost === undefined) throw new Invalid("cost", "COST MUST BE DOLLARS AND CENTS, E.G. 1.25");
	const price = cents(inp.price);
	if (price === undefined) throw new Invalid("price", "PRICE MUST BE DOLLARS AND CENTS, E.G. 2.49");
	const status = text(inp.status, 1) || "A";
	if (status !== "A" && status !== "D") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR D (DISCONTINUED)");
	return {
		sku, upc, desc, dept, cost, price, status,
		class: text(inp.class, 4), vendor: text(inp.vendor, 8),
		taxable: yesNo(inp.taxable, "taxable", d.taxable === 1), weighed: yesNo(inp.weighed, "weighed", false),
	};
}

async function upcTaken(db: D1Database, upc: string, sku: string): Promise<void> {
	if (!upc) return;
	const other = await db.prepare("SELECT sku FROM items WHERE upc = ? AND sku <> ?").bind(upc, sku).first<{ sku: string }>();
	if (other) throw new Invalid("upc", `UPC IS ALREADY ON SKU ${other.sku}`);
}

export async function addItem(db: D1Database, userid: string, inp: ItemInput): Promise<Item> {
	const it = await checkItem(db, inp);
	if (await getItem(db, it.sku)) throw new Invalid("sku", `SKU ${it.sku} ALREADY EXISTS`);
	await upcTaken(db, it.upc, it.sku);
	const at = now();
	await unique(db.batch([
		db.prepare(`INSERT INTO items (sku, upc, descr, dept, class, vendor, cost, price, taxable, weighed, status, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(it.sku, it.upc || null, it.desc, it.dept, it.class, it.vendor, it.cost, it.price, it.taxable ? 1 : 0, it.weighed ? 1 : 0,
				it.status, at, userid),
		audit(db, userid, { action: "ITEM.ADD", subject: it.sku, detail: `${it.desc} price=${it.price}` }, at),
	]), new Invalid("sku", `SKU ${it.sku} OR ITS UPC ALREADY EXISTS`));
	return (await getItem(db, it.sku))!;
}

export async function updateItem(db: D1Database, userid: string, version: number, inp: ItemInput): Promise<Item> {
	const it = await checkItem(db, inp);
	const before = await getItem(db, it.sku);
	if (!before || before.version !== version) throw new Conflict(`SKU ${it.sku} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	await upcTaken(db, it.upc, it.sku);
	const at = now();
	const [upd] = await unique(db.batch([
		db.prepare(`UPDATE items SET upc = ?, descr = ?, dept = ?, class = ?, vendor = ?, cost = ?, price = ?, taxable = ?, weighed = ?,
			status = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE sku = ? AND version = ?`)
			.bind(it.upc || null, it.desc, it.dept, it.class, it.vendor, it.cost, it.price, it.taxable ? 1 : 0, it.weighed ? 1 : 0,
				it.status, at, userid, it.sku, version),
		audit(db, userid, {
			action: "ITEM.UPDATE", subject: it.sku,
			detail: diff(before, { ...before, ...it }, ["upc", "desc", "dept", "class", "vendor", "cost", "price", "taxable", "weighed", "status"]),
		}, at),
	]), new Invalid("upc", "UPC IS ALREADY ON ANOTHER ITEM"));
	if (changed(upd) === 0) throw new Conflict(`SKU ${it.sku} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await getItem(db, it.sku))!;
}

// --- Price book ---

export interface PriceLine {
	sku: string;
	desc: string;
	weighed: boolean;
	base: number;
	store?: number; // the store's own price, if it has one
}

// priceBook lists items with a store's price for each, by SKU.
export async function priceBook(db: D1Database, store: number, q: Omit<ItemQuery, "dept">): Promise<{ lines: PriceLine[]; total: number }> {
	const t = text(q.q, 30);
	const w = t ? " WHERE (i.sku LIKE ? ESCAPE '\\' OR i.descr LIKE ? ESCAPE '\\')" : "";
	const args = t ? [likeText(t) + "%", "%" + likeText(t) + "%"] : [];
	const [rows, count] = await db.batch<{ sku: string; desc: string; weighed: number; base: number; store: number | null } | { n: number }>([
		db.prepare(`SELECT i.sku, i.descr AS "desc", i.weighed, i.price AS base, p.price AS store
			FROM items i LEFT JOIN prices p ON p.sku = i.sku AND p.store = ?${w} ORDER BY i.sku LIMIT ? OFFSET ?`)
			.bind(store, ...args, q.limit, q.offset),
		db.prepare(`SELECT COUNT(*) AS n FROM items i${w}`).bind(...args),
	]);
	const lines = (rows.results as { sku: string; desc: string; weighed: number; base: number; store: number | null }[])
		.map((r) => ({ sku: r.sku, desc: r.desc, weighed: r.weighed === 1, base: r.base, ...(r.store === null ? {} : { store: r.store }) }));
	return { lines, total: (count.results[0] as { n: number }).n };
}

// setPrice gives an item its own price at a store, or with undefined goes
// back to the base price.
export async function setPrice(db: D1Database, userid: string, store: number, sku: string, price: number | undefined): Promise<void> {
	const at = now();
	const write = price === undefined
		? db.prepare("DELETE FROM prices WHERE store = ? AND sku = ?").bind(store, sku)
		: db.prepare(`INSERT INTO prices (store, sku, price, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (store, sku) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
			.bind(store, sku, price, at, userid);
	await db.batch([
		write,
		audit(db, userid, { action: "PRICE.SET", subject: sku, store, detail: price === undefined ? "base" : `price=${price}` }, at),
	]);
}

// priceAt is what an item sells for at a store.
export async function priceAt(db: D1Database, store: number, sku: string): Promise<number | undefined> {
	const r = await db.prepare("SELECT COALESCE(p.price, i.price) AS price FROM items i LEFT JOIN prices p ON p.sku = i.sku AND p.store = ? WHERE i.sku = ?")
		.bind(store, sku).first<{ price: number }>();
	return r?.price;
}
