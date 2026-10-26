// Purchasing: the vendor file, reorder points, purchase orders, receiving
// against them, suggested orders and returns to vendors. Receiving and
// returns move the stock ledger in the same batch as the rest, each move
// unique by what made it.

import { cents } from "../money";
import { audit, changed, Conflict, diff, Invalid, now, text, unique } from "./db";
import { getItem } from "./items";
import { readQty } from "./stock";

// --- Vendors ---

export interface Vendor {
	code: string;
	name: string;
	contact: string;
	phone: string;
	email: string;
	terms: string;
	leadDays: number;
	status: "A" | "I";
	version: number;
	updatedAt: string;
	updatedBy: string;
}

export type VendorInput = Record<"code" | "name" | "contact" | "phone" | "email" | "terms" | "leadDays" | "status", string>;

const VENDOR_COLS = `code, name, contact, phone, email, terms, lead_days AS leadDays, status, version, updated_at AS updatedAt,
	updated_by AS updatedBy`;

export async function listVendors(db: D1Database, offset: number, limit: number): Promise<{ vendors: Vendor[]; total: number }> {
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT ${VENDOR_COLS} FROM vendors ORDER BY code LIMIT ? OFFSET ?`).bind(limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM vendors"),
	]);
	return { vendors: rows.results as unknown as Vendor[], total: (count.results[0] as { n: number }).n };
}

export async function getVendor(db: D1Database, code: string): Promise<Vendor | undefined> {
	return (await db.prepare(`SELECT ${VENDOR_COLS} FROM vendors WHERE code = ?`).bind(code).first<Vendor>()) ?? undefined;
}

function checkVendor(inp: VendorInput): Omit<Vendor, "version" | "updatedAt" | "updatedBy"> {
	const code = text(inp.code, 8);
	if (!/^[A-Z0-9-]{1,8}$/.test(code)) throw new Invalid("code", "CODE IS 1 TO 8 LETTERS, DIGITS OR DASHES");
	const name = text(inp.name, 30);
	if (!name) throw new Invalid("name", "NAME IS REQUIRED");
	const email = inp.email.trim().slice(0, 60);
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Invalid("email", "EMAIL LOOKS LIKE NAME@EXAMPLE.COM");
	const lead = inp.leadDays.trim() || "7";
	if (!/^\d{1,3}$/.test(lead) || Number(lead) > 365) throw new Invalid("leadDays", "LEAD TIME IS 0 TO 365 DAYS");
	const status = text(inp.status, 1) || "A";
	if (status !== "A" && status !== "I") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR I (INACTIVE)");
	return { code, name, contact: text(inp.contact, 30), phone: text(inp.phone, 20), email, terms: text(inp.terms, 20), leadDays: Number(lead), status };
}

export async function addVendor(db: D1Database, userid: string, inp: VendorInput): Promise<Vendor> {
	const v = checkVendor(inp);
	const at = now();
	await unique(db.batch([
		db.prepare(`INSERT INTO vendors (code, name, contact, phone, email, terms, lead_days, status, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(v.code, v.name, v.contact, v.phone, v.email, v.terms, v.leadDays, v.status, at, userid),
		audit(db, userid, { action: "VENDOR.ADD", subject: v.code, detail: v.name }, at),
	]), new Invalid("code", `VENDOR ${v.code} ALREADY EXISTS`));
	return (await getVendor(db, v.code))!;
}

export async function updateVendor(db: D1Database, userid: string, version: number, inp: VendorInput): Promise<Vendor> {
	const v = checkVendor(inp);
	const before = await getVendor(db, v.code);
	if (!before || before.version !== version) throw new Conflict(`VENDOR ${v.code} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	const at = now();
	const [upd] = await db.batch([
		db.prepare(`UPDATE vendors SET name = ?, contact = ?, phone = ?, email = ?, terms = ?, lead_days = ?, status = ?,
			version = version + 1, updated_at = ?, updated_by = ? WHERE code = ? AND version = ?`)
			.bind(v.name, v.contact, v.phone, v.email, v.terms, v.leadDays, v.status, at, userid, v.code, version),
		audit(db, userid, {
			action: "VENDOR.UPDATE", subject: v.code,
			detail: diff(before, { ...before, ...v }, ["name", "contact", "phone", "email", "terms", "leadDays", "status"]),
		}, at),
	]);
	if (changed(upd) === 0) throw new Conflict(`VENDOR ${v.code} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await getVendor(db, v.code))!;
}

// --- Reorder points ---

export interface ReorderLine {
	sku: string;
	desc: string;
	weighed: boolean;
	onHand: number;
	min: number | null;
	max: number | null;
}

export async function reorderPoints(
	db: D1Database, store: number, q: { vendor?: string; offset: number; limit: number },
): Promise<{ lines: ReorderLine[]; total: number }> {
	const w = `WHERE i.status = 'A'${q.vendor ? " AND i.vendor = ?" : ""}`;
	const args = q.vendor ? [q.vendor] : [];
	const from = `FROM items i LEFT JOIN stock st ON st.store = ? AND st.sku = i.sku ${w}`;
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT i.sku, i.descr AS desc, i.weighed, COALESCE(st.on_hand, 0) AS onHand, st.min_qty AS min, st.max_qty AS max
			${from} ORDER BY i.sku LIMIT ? OFFSET ?`).bind(store, ...args, q.limit, q.offset),
		db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(store, ...args),
	]);
	const lines = (rows.results as (Omit<ReorderLine, "weighed"> & { weighed: number })[]).map((r) => ({ ...r, weighed: r.weighed === 1 }));
	return { lines, total: (count.results[0] as { n: number }).n };
}

// setReorder sets an item's min and max at a store; both null clears them.
export async function setReorder(db: D1Database, userid: string, store: number, sku: string, min: number | null, max: number | null): Promise<void> {
	if ((min === null) !== (max === null)) throw new Invalid(`min:${sku}`, `${sku}: KEY BOTH MIN AND MAX, OR NEITHER`);
	if (min !== null && max !== null && max < min) throw new Invalid(`max:${sku}`, `${sku}: MAX MUST BE AT LEAST MIN`);
	const at = now();
	await db.batch([
		db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at, min_qty, max_qty) VALUES (?, ?, 0, ?, ?, ?)
			ON CONFLICT (store, sku) DO UPDATE SET min_qty = excluded.min_qty, max_qty = excluded.max_qty`).bind(store, sku, at, min, max),
		audit(db, userid, { action: "STOCK.REORDER", subject: sku, store, detail: `min=${min ?? ""} max=${max ?? ""}` }, at),
	]);
}

// --- Purchase orders ---

export type PoStatus = "D" | "O" | "P" | "R" | "X";
export const PO_STATUS: Record<PoStatus, string> = { D: "DRAFT", O: "ORDERED", P: "PART RECEIVED", R: "RECEIVED", X: "CANCELLED" };

export interface PoLine {
	sku: string;
	desc: string;
	weighed: boolean;
	qty: number;
	cost: number;
	received: number;
}

export interface Po {
	id: number;
	vendor: string;
	vendorName: string;
	store: number;
	status: PoStatus;
	expected: string;
	createdAt: string;
	createdBy: string;
	orderedAt: string | null;
	total: number; // cents, what was ordered
	lines: PoLine[];
}

// lineCost is what qty (thousandths) costs at cost per unit.
export const lineCost = (qty: number, cost: number) => Math.round((qty * cost) / 1000);

export type PoLineInput = { sku: string; qty: string; cost: string }[];

// readPoLines checks the lines keyed for a PO or a vendor return. A blank
// cost takes the item's cost. Lines are named by their row, for the field
// that is wrong.
export async function readPoLines(db: D1Database, typed: PoLineInput, vendor?: string): Promise<{ sku: string; qty: number; cost: number }[]> {
	const lines: { sku: string; qty: number; cost: number }[] = [];
	for (const [i, t] of typed.entries()) {
		const sku = text(t.sku, 14);
		if (!sku && !t.qty.trim() && !t.cost.trim()) continue;
		const it = sku ? await getItem(db, sku) : undefined;
		if (!it) throw new Invalid(`sku:${i}`, sku ? `ITEM ${sku} NOT FOUND` : "KEY THE ITEM'S SKU");
		if (vendor && it.vendor && it.vendor !== vendor) throw new Invalid(`sku:${i}`, `${sku} COMES FROM VENDOR ${it.vendor}`);
		const qty = readQty(t.qty, it.weighed);
		if (!qty) throw new Invalid(`qty:${i}`, it.weighed ? "KEY THE POUNDS, E.G. 25" : "KEY HOW MANY, 1 OR MORE");
		const cost = t.cost.trim() ? cents(t.cost) : it.cost;
		if (cost === undefined) throw new Invalid(`cost:${i}`, "COST IS DOLLARS AND CENTS, E.G. 4.12");
		if (lines.some((l) => l.sku === sku)) throw new Invalid(`sku:${i}`, `${sku} IS KEYED TWICE`);
		lines.push({ sku, qty, cost });
	}
	return lines;
}

// readDate reads YYYY-MM-DD, or "" for blank.
export function readDate(s: string, field: string): string {
	const t = s.trim();
	if (!t) return "";
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
	const d = m ? new Date(`${t}T00:00:00Z`) : undefined;
	if (!d || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) throw new Invalid(field, "DATE IS YYYY-MM-DD");
	return t;
}

// newPo starts a draft PO. The newest PO this person started is the one
// just added: each statement in the batch runs in order, alone.
export async function newPo(
	db: D1Database, userid: string, vendor: string, store: number, expected: string, lines: { sku: string; qty: number; cost: number }[],
): Promise<number> {
	if (lines.length === 0) throw new Invalid("sku:0", "KEY AT LEAST ONE ITEM TO ORDER");
	const v = await getVendor(db, vendor);
	if (!v || v.status !== "A") throw new Invalid("vendor", `VENDOR ${vendor} ${v ? "IS INACTIVE" : "NOT FOUND"}`);
	const at = now();
	const po = "(SELECT MAX(id) FROM purchase_orders WHERE created_by = ?)";
	await db.batch([
		db.prepare("INSERT INTO purchase_orders (vendor, store, expected, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
			.bind(vendor, store, expected, at, userid),
		...lines.map((l) => db.prepare(`INSERT INTO po_lines (po, sku, qty, cost) VALUES (${po}, ?, ?, ?)`).bind(userid, l.sku, l.qty, l.cost)),
		db.prepare(`INSERT INTO audit (at, userid, store, action, subject, detail) VALUES (?, ?, ?, 'PO.ADD', CAST(${po} AS TEXT), ?)`)
			.bind(at, userid, store, userid, `vendor=${vendor} lines=${lines.length}`),
	]);
	return (await db.prepare(`SELECT ${po} AS id`).bind(userid).first<{ id: number }>())!.id;
}

export interface PoRow {
	id: number;
	vendor: string;
	store: number;
	status: PoStatus;
	expected: string;
	createdAt: string;
	total: number;
}

export async function listPos(
	db: D1Database, stores: number[], q: { vendor?: string; open?: boolean; offset: number; limit: number },
): Promise<{ pos: PoRow[]; total: number }> {
	const where: string[] = [];
	const args: unknown[] = [];
	if (stores.length) {
		where.push(`p.store IN (${stores.map(() => "?").join(",")})`);
		args.push(...stores);
	}
	if (q.vendor) {
		where.push("p.vendor = ?");
		args.push(q.vendor);
	}
	if (q.open) where.push("p.status IN ('D', 'O', 'P')");
	const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT p.id, p.vendor, p.store, p.status, p.expected, p.created_at AS createdAt,
			(SELECT COALESCE(SUM((l.qty * l.cost + 500) / 1000), 0) FROM po_lines l WHERE l.po = p.id) AS total
			FROM purchase_orders p ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`).bind(...args, q.limit, q.offset),
		db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders p ${w}`).bind(...args),
	]);
	return { pos: rows.results as unknown as PoRow[], total: (count.results[0] as { n: number }).n };
}

export async function getPo(db: D1Database, id: number): Promise<Po | undefined> {
	const [p, l] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT p.id, p.vendor, v.name AS vendorName, p.store, p.status, p.expected, p.created_at AS createdAt,
			p.created_by AS createdBy, p.ordered_at AS orderedAt FROM purchase_orders p JOIN vendors v ON v.code = p.vendor WHERE p.id = ?`).bind(id),
		db.prepare(`SELECT l.sku, i.descr AS desc, i.weighed, l.qty, l.cost, l.received FROM po_lines l JOIN items i ON i.sku = l.sku
			WHERE l.po = ? ORDER BY l.sku`).bind(id),
	]);
	const row = p.results[0] as Omit<Po, "lines" | "total"> | undefined;
	if (!row) return undefined;
	const lines = (l.results as (Omit<PoLine, "weighed"> & { weighed: number })[]).map((x) => ({ ...x, weighed: x.weighed === 1 }));
	return { ...row, lines, total: lines.reduce((t, x) => t + lineCost(x.qty, x.cost), 0) };
}

// orderPo places a draft PO with the vendor.
export async function orderPo(db: D1Database, userid: string, id: number): Promise<boolean> {
	const at = now();
	const r = await db.prepare("UPDATE purchase_orders SET status = 'O', ordered_at = ?, ordered_by = ? WHERE id = ? AND status = 'D'")
		.bind(at, userid, id).run();
	if (changed(r) === 0) return false;
	await audit(db, userid, { action: "PO.ORDER", subject: String(id) }, at).run();
	return true;
}

// cancelPo cancels a PO nothing has been received on yet.
export async function cancelPo(db: D1Database, userid: string, id: number): Promise<boolean> {
	const at = now();
	const r = await db.prepare("UPDATE purchase_orders SET status = 'X', closed_at = ? WHERE id = ? AND status IN ('D', 'O')").bind(at, id).run();
	if (changed(r) === 0) return false;
	await audit(db, userid, { action: "PO.CANCEL", subject: String(id) }, at).run();
	return true;
}

// receivePo receives a delivery against an ordered PO: what came, line by
// line, more or less than was ordered. On hand goes up, the ledger says
// so, and each item's cost becomes the average of what was on hand (in
// every store) and what came, at the PO's cost. The PO is received when
// every line has come in full, or when close is set (nothing more is
// coming). token names the delivery, so it is received once.
export async function receivePo(
	db: D1Database, userid: string, id: number, token: string, got: [string, number][], close: boolean,
): Promise<"received" | "partial" | "already"> {
	const po = await getPo(db, id);
	if (!po || (po.status !== "O" && po.status !== "P")) return "already";
	const lines = got.filter(([, q]) => q > 0).map(([sku, q]) => ({ line: po.lines.find((l) => l.sku === sku)!, q }));
	if (lines.length === 0 && !close) throw new Invalid("", "KEY WHAT CAME IN BESIDE AT LEAST ONE LINE");
	const done = po.lines.every((l) => l.received + (lines.find((x) => x.line.sku === l.sku)?.q ?? 0) >= l.qty);
	const status = done || close ? "R" : "P";
	const at = now();
	const rcpt = "(SELECT id FROM po_receipts WHERE token = ?)";
	const onHandAll = "(SELECT COALESCE(SUM(MAX(on_hand, 0)), 0) FROM stock WHERE sku = ?)";
	try {
		await db.batch([
			// Refused (UNIQUE) if this delivery was received already.
			db.prepare("INSERT INTO po_receipts (po, token, at, userid) VALUES (?, ?, ?, ?)").bind(id, token, at, userid),
			...lines.flatMap(({ line: l, q }) => [
				// Average cost, before on hand goes up.
				db.prepare(`UPDATE items SET cost = CAST(ROUND((cost * ${onHandAll} + ? * ?) * 1.0 / MAX(${onHandAll} + ?, 1)) AS INTEGER),
					version = version + 1, updated_at = ?, updated_by = ? WHERE sku = ?`)
					.bind(l.sku, l.cost, q, l.sku, q, at, userid, l.sku),
				db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, reason, userid)
					VALUES (?, ?, ?, 'RECEIVE', ?, ${rcpt} || ':' || ?, ?, ?)`).bind(po.store, l.sku, at, q, token, l.sku, `PO ${id}`, userid),
				db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at) VALUES (?, ?, ?, ?)
					ON CONFLICT (store, sku) DO UPDATE SET on_hand = on_hand + excluded.on_hand, updated_at = excluded.updated_at`)
					.bind(po.store, l.sku, q, at),
				db.prepare("UPDATE po_lines SET received = received + ? WHERE po = ? AND sku = ?").bind(q, id, l.sku),
			]),
			db.prepare(`UPDATE purchase_orders SET status = ?, closed_at = ${status === "R" ? "?" : "closed_at"} WHERE id = ?`)
				.bind(...(status === "R" ? [status, at, id] : [status, id])),
			audit(db, userid, { action: "PO.RECEIVE", subject: String(id), store: po.store, detail: `lines=${lines.length}${close ? " closed" : ""}` }, at),
		]);
	} catch (e) {
		if (e instanceof Error && /UNIQUE constraint failed: po_receipts.token/.test(e.message)) return "already";
		throw e;
	}
	return status === "R" ? "received" : "partial";
}

// --- Suggested orders ---

export interface Suggestion {
	sku: string;
	desc: string;
	weighed: boolean;
	onHand: number;
	onOrder: number;
	min: number | null;
	max: number | null;
	sold: number; // the last 28 days
	cost: number;
	qty: number; // suggested
}

// suggest works out what a store should order from a vendor. An item with
// reorder points is ordered when on hand plus on order is at or below its
// min, back up to its max. One without is ordered to cover its sales over
// the vendor's lead time plus two weeks, at the rate of the last 28 days.
// Whole units are rounded up.
export async function suggest(db: D1Database, store: number, vendor: string, today: string): Promise<Suggestion[]> {
	const v = await getVendor(db, vendor);
	if (!v) return [];
	const since = new Date(Date.parse(`${today}T00:00:00Z`) - 28 * 86400000).toISOString();
	const rows = (await db.prepare(`SELECT i.sku, i.descr AS desc, i.weighed, i.cost, COALESCE(st.on_hand, 0) AS onHand,
			st.min_qty AS min, st.max_qty AS max,
			(SELECT COALESCE(SUM(l.qty - l.received), 0) FROM po_lines l JOIN purchase_orders p ON p.id = l.po
				WHERE l.sku = i.sku AND p.store = ? AND p.status IN ('D', 'O', 'P') AND l.qty > l.received) AS onOrder,
			(SELECT COALESCE(-SUM(m.qty), 0) FROM stock_moves m WHERE m.store = ? AND m.sku = i.sku AND m.kind IN ('SALE', 'VOID')
				AND m.at >= ?) AS sold
		FROM items i LEFT JOIN stock st ON st.store = ? AND st.sku = i.sku
		WHERE i.vendor = ? AND i.status = 'A' ORDER BY i.sku`).bind(store, store, since, store, vendor)
		.all<Omit<Suggestion, "weighed" | "qty"> & { weighed: number }>()).results;
	const out: Suggestion[] = [];
	for (const r of rows) {
		const have = r.onHand + r.onOrder;
		let want = 0;
		if (r.min !== null && r.max !== null) want = have <= r.min ? r.max - have : 0;
		else if (r.sold > 0) want = Math.round((r.sold * (v.leadDays + 14)) / 28) - have;
		if (want <= 0) continue;
		const qty = r.weighed === 1 ? want : Math.ceil(want / 1000) * 1000;
		out.push({ ...r, weighed: r.weighed === 1, qty });
	}
	return out;
}

// --- Returns to vendors ---

export async function returnToVendor(
	db: D1Database, userid: string, token: string, vendor: string, store: number, reason: string,
	lines: { sku: string; qty: number; cost: number }[],
): Promise<number> {
	if (lines.length === 0) throw new Invalid("sku:0", "KEY AT LEAST ONE ITEM GOING BACK");
	const v = await getVendor(db, vendor);
	if (!v) throw new Invalid("vendor", `VENDOR ${vendor} NOT FOUND`);
	const at = now();
	const ret = "(SELECT id FROM vendor_returns WHERE token = ?)";
	try {
		await db.batch([
			db.prepare("INSERT INTO vendor_returns (vendor, store, token, reason, at, userid) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(vendor, store, token, text(reason, 30), at, userid),
			...lines.flatMap((l) => [
				db.prepare(`INSERT INTO vendor_return_lines (ret, sku, qty, cost) VALUES (${ret}, ?, ?, ?)`).bind(token, l.sku, l.qty, l.cost),
				db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, reason, userid)
					VALUES (?, ?, ?, 'VRETURN', ?, ${ret} || ':' || ?, ?, ?)`).bind(store, l.sku, at, -l.qty, token, l.sku, vendor, userid),
				db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at) VALUES (?, ?, ?, ?)
					ON CONFLICT (store, sku) DO UPDATE SET on_hand = on_hand + excluded.on_hand, updated_at = excluded.updated_at`)
					.bind(store, l.sku, -l.qty, at),
			]),
			db.prepare(`INSERT INTO audit (at, userid, store, action, subject, detail) VALUES (?, ?, ?, 'VENDOR.RETURN', CAST(${ret} AS TEXT), ?)`)
				.bind(at, userid, store, token, `vendor=${vendor} lines=${lines.length}`),
		]);
	} catch (e) {
		if (!(e instanceof Error && /UNIQUE constraint failed: vendor_returns.token/.test(e.message))) throw e;
	}
	return (await db.prepare(`SELECT ${ret} AS id`).bind(token).first<{ id: number }>())!.id;
}
