// Inventory: on hand per store, the stock ledger, adjustments, counts and
// transfers. Every change to on hand writes a ledger row in the same batch,
// and each ledger row is unique by what made it (kind, ref, line, store),
// so posting anything twice changes nothing.

import { audit, changed, Invalid, now, text } from "./db";
import { getItem } from "./items";

// --- Quantities ---

// readQty reads a quantity as typed: whole units, or pounds to three places
// for a weighed item, in thousandths. signed allows a leading minus.
export function readQty(s: string, weighed: boolean, signed = false): number | undefined {
	const t = s.trim();
	const m = (weighed ? /^(-)?(\d{1,5})?(?:\.(\d{1,3}))?$/ : /^(-)?(\d{1,6})$/).exec(t);
	if (!t || !m || (m[1] && !signed) || (!m[2] && !m[3])) return undefined;
	const q = Number(m[2] ?? "0") * 1000 + Number((m[3] ?? "").padEnd(3, "0") || "0");
	return m[1] ? -q : q;
}

// showQty shows a quantity: whole units, or pounds to three places.
export const showQty = (q: number, weighed: boolean) => (weighed ? (q / 1000).toFixed(3) : String(Math.round(q / 1000)));

// upsert adds qty to on hand, making the row if there is none.
const ADD = `ON CONFLICT (store, sku) DO UPDATE SET on_hand = on_hand + excluded.on_hand, updated_at = excluded.updated_at`;

// --- Posting sales ---

// postSale moves a sale into the ledger: what it sold comes off on hand and
// what came back goes on. A sale post-voided after it was posted is put
// back. Each step is one batch, guarded by sales.posted, so posting a sale
// again (a queue message delivered twice, the sweep catching up) does
// nothing. Lines for things that aren't items, such as gift cards, are
// skipped.
export async function postSale(db: D1Database, id: number): Promise<void> {
	const at = now();
	const lines = (where: string) => `FROM sales s JOIN sale_lines l ON l.sale = s.id JOIN items i ON i.sku = l.sku
		WHERE s.id = ? AND ${where} AND l.voided = 0`;
	const sold = "s.status IN ('C', 'V') AND s.posted = 0";
	const voided = "s.status = 'V' AND s.posted = 1";
	await db.batch([
		db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, line, userid)
			SELECT s.store, l.sku, ?, 'SALE', -l.qty, CAST(s.id AS TEXT), l.line, 'POSTING' ${lines(sold)}`).bind(at, id),
		db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at)
			SELECT s.store, l.sku, -SUM(l.qty), ? ${lines(sold)} GROUP BY s.store, l.sku ${ADD}`).bind(at, id),
		db.prepare("UPDATE sales SET posted = 1 WHERE id = ? AND status IN ('C', 'V') AND posted = 0").bind(id),
		db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, line, userid)
			SELECT s.store, l.sku, ?, 'VOID', l.qty, CAST(s.id AS TEXT), l.line, 'POSTING' ${lines(voided)}`).bind(at, id),
		db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at)
			SELECT s.store, l.sku, SUM(l.qty), ? ${lines(voided)} GROUP BY s.store, l.sku ${ADD}`).bind(at, id),
		db.prepare("UPDATE sales SET posted = 2 WHERE id = ? AND status = 'V' AND posted = 1").bind(id),
	]);
}

// unposted lists sales the ledger hasn't caught up with: paid for and not
// posted, or post-voided after they were. A sale cancelled before it was
// paid for never moved anything.
export async function unposted(db: D1Database, limit: number): Promise<number[]> {
	const r = await db.prepare(`SELECT id FROM sales WHERE (posted = 0 AND status IN ('C', 'V')) OR (posted = 1 AND status = 'V')
		ORDER BY id LIMIT ?`).bind(limit).all<{ id: number }>();
	return r.results.map((x) => x.id);
}

// --- On hand and the ledger ---

export interface StockLine {
	sku: string;
	desc: string;
	dept: number;
	weighed: boolean;
	onHand: number;
}

// listStock lists a store's on hand for the items that match, by SKU.
export async function listStock(
	db: D1Database, store: number, q: { q?: string; dept?: number; offset: number; limit: number },
): Promise<{ lines: StockLine[]; total: number }> {
	const where = ["(i.status = 'A' OR st.on_hand <> 0)"];
	const args: unknown[] = [];
	const t = text(q.q, 30);
	if (t) {
		where.push("(i.sku LIKE ? ESCAPE '\\' OR i.upc = ? OR i.descr LIKE ? ESCAPE '\\')");
		const like = t.replace(/[\\%_]/g, (c) => "\\" + c);
		args.push(like + "%", t, "%" + like + "%");
	}
	if (q.dept) {
		where.push("i.dept = ?");
		args.push(q.dept);
	}
	const from = `FROM items i LEFT JOIN stock st ON st.store = ? AND st.sku = i.sku WHERE ${where.join(" AND ")}`;
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT i.sku, i.descr AS desc, i.dept, i.weighed, COALESCE(st.on_hand, 0) AS onHand ${from} ORDER BY i.sku LIMIT ? OFFSET ?`)
			.bind(store, ...args, q.limit, q.offset),
		db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(store, ...args),
	]);
	const lines = (rows.results as (Omit<StockLine, "weighed"> & { weighed: number })[]).map((r) => ({ ...r, weighed: r.weighed === 1 }));
	return { lines, total: (count.results[0] as { n: number }).n };
}

export async function onHand(db: D1Database, store: number, sku: string): Promise<number> {
	return (await db.prepare("SELECT on_hand FROM stock WHERE store = ? AND sku = ?").bind(store, sku).first<{ on_hand: number }>())?.on_hand ?? 0;
}

export interface Move {
	id: number;
	at: string;
	kind: string;
	qty: number;
	ref: string;
	reason: string;
	userid: string;
}

// ledger lists an item's moves at a store, newest first.
export async function ledger(db: D1Database, store: number, sku: string, offset: number, limit: number): Promise<{ moves: Move[]; total: number }> {
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT id, at, kind, qty, ref, reason, userid FROM stock_moves WHERE store = ? AND sku = ?
			ORDER BY id DESC LIMIT ? OFFSET ?`).bind(store, sku, limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE store = ? AND sku = ?").bind(store, sku),
	]);
	return { moves: rows.results as unknown as Move[], total: (count.results[0] as { n: number }).n };
}

// --- Adjustments ---

export const REASONS: Record<string, string> = { DM: "DAMAGED", SH: "SHRINK", FD: "FOUND", US: "STORE USE", OT: "OTHER" };

// adjust changes on hand by qty, with a reason. token names the adjustment,
// so one keyed twice is made once.
export async function adjust(
	db: D1Database, userid: string, token: string, store: number, sku: string, qty: number, reason: string,
): Promise<void> {
	if (!REASONS[reason]) throw new Invalid("reason", `REASON MUST BE ${Object.keys(REASONS).join(", ")}`);
	if (qty === 0) throw new Invalid("qty", "KEY HOW MANY MORE (OR -FEWER) THERE ARE");
	const at = now();
	try {
		await db.batch([
			db.prepare("INSERT INTO stock_moves (store, sku, at, kind, qty, ref, reason, userid) VALUES (?, ?, ?, 'ADJUST', ?, ?, ?, ?)")
				.bind(store, sku, at, qty, token, reason, userid),
			db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at) VALUES (?, ?, ?, ?) ${ADD}`).bind(store, sku, qty, at),
			audit(db, userid, { action: "STOCK.ADJUST", subject: sku, store, detail: `qty=${qty} reason=${reason}` }, at),
		]);
	} catch (e) {
		if (!(e instanceof Error && /UNIQUE constraint failed/.test(e.message))) throw e;
	}
}

// --- Counts ---

export interface Count {
	id: number;
	store: number;
	kind: "CYCLE" | "FULL";
	dept: number | null;
	status: "O" | "P" | "X";
	createdAt: string;
	createdBy: string;
	doneAt: string | null;
	doneBy: string | null;
	lines: number;
	counted: number;
}

const COUNT_COLS = `c.id, c.store, c.kind, c.dept, c.status, c.created_at AS createdAt, c.created_by AS createdBy, c.done_at AS doneAt,
	c.done_by AS doneBy, (SELECT COUNT(*) FROM count_lines WHERE count = c.id) AS lines,
	(SELECT COUNT(counted) FROM count_lines WHERE count = c.id) AS counted`;

// newCount starts a count: a cycle count of one department's active items,
// or a full count of every active item.
export async function newCount(db: D1Database, userid: string, store: number, dept: number | undefined): Promise<number> {
	const at = now();
	const [, lines] = await db.batch([
		db.prepare("INSERT INTO counts (store, kind, dept, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
			.bind(store, dept ? "CYCLE" : "FULL", dept ?? null, at, userid),
		db.prepare(`INSERT INTO count_lines (count, sku) SELECT last_insert_rowid(), sku FROM items WHERE status = 'A'${dept ? " AND dept = ?" : ""}`)
			.bind(...(dept ? [dept] : [])),
	]);
	const id = (await db.prepare("SELECT MAX(id) AS id FROM counts WHERE store = ? AND created_by = ?").bind(store, userid).first<{ id: number }>())!.id;
	await audit(db, userid, { action: "COUNT.START", subject: String(id), store, detail: `${dept ? `dept=${dept}` : "full"} lines=${changed(lines)}` }).run();
	return id;
}

export async function listCounts(db: D1Database, stores: number[], offset: number, limit: number): Promise<{ counts: Count[]; total: number }> {
	const w = stores.length ? `WHERE c.store IN (${stores.map(() => "?").join(",")})` : "";
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT ${COUNT_COLS} FROM counts c ${w} ORDER BY c.id DESC LIMIT ? OFFSET ?`).bind(...stores, limit, offset),
		db.prepare(`SELECT COUNT(*) AS n FROM counts c ${w}`).bind(...stores),
	]);
	return { counts: rows.results as unknown as Count[], total: (count.results[0] as { n: number }).n };
}

export async function getCount(db: D1Database, id: number): Promise<Count | undefined> {
	return (await db.prepare(`SELECT ${COUNT_COLS} FROM counts c WHERE c.id = ?`).bind(id).first<Count>()) ?? undefined;
}

export interface CountLine {
	sku: string;
	desc: string;
	weighed: boolean;
	onHand: number; // now
	counted: number | null;
}

export async function countLines(db: D1Database, c: Pick<Count, "id" | "store">, offset: number, limit: number): Promise<CountLine[]> {
	const r = await db.prepare(`SELECT cl.sku, i.descr AS desc, i.weighed, COALESCE(st.on_hand, 0) AS onHand, cl.counted
		FROM count_lines cl JOIN items i ON i.sku = cl.sku LEFT JOIN stock st ON st.store = ? AND st.sku = cl.sku
		WHERE cl.count = ? ORDER BY cl.sku LIMIT ? OFFSET ?`).bind(c.store, c.id, limit, offset).all<Omit<CountLine, "weighed"> & { weighed: number }>();
	return r.results.map((x) => ({ ...x, weighed: x.weighed === 1 }));
}

// setCounted records what was counted (null: not counted yet) on an open
// count.
export async function setCounted(db: D1Database, id: number, counted: [string, number | null][]): Promise<void> {
	if (counted.length === 0) return;
	await db.batch(counted.map(([sku, q]) =>
		db.prepare("UPDATE count_lines SET counted = ? WHERE count = ? AND sku = ? AND EXISTS (SELECT 1 FROM counts WHERE id = ? AND status = 'O')")
			.bind(q, id, sku, id)));
}

// postCount sets on hand to what was counted, writing the difference to the
// ledger, and closes the count. Items not counted are left as they are.
export async function postCount(db: D1Database, userid: string, id: number): Promise<boolean> {
	const at = now();
	const from = `FROM counts c JOIN count_lines cl ON cl.count = c.id LEFT JOIN stock st ON st.store = c.store AND st.sku = cl.sku
		WHERE c.id = ? AND c.status = 'O' AND cl.counted IS NOT NULL`;
	const r = await db.batch([
		db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, reason, userid)
			SELECT c.store, cl.sku, ?, 'COUNT', cl.counted - COALESCE(st.on_hand, 0), c.id || ':' || cl.sku, c.kind, ? ${from}
			AND cl.counted <> COALESCE(st.on_hand, 0)`).bind(at, userid, id),
		db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at) SELECT c.store, cl.sku, cl.counted, ? ${from}
			ON CONFLICT (store, sku) DO UPDATE SET on_hand = excluded.on_hand, updated_at = excluded.updated_at`).bind(at, id),
		db.prepare("UPDATE counts SET status = 'P', done_at = ?, done_by = ? WHERE id = ? AND status = 'O'").bind(at, userid, id),
	]);
	if (changed(r[2]) === 0) return false;
	await audit(db, userid, { action: "COUNT.POST", subject: String(id), detail: `changed=${changed(r[0])}` }, at).run();
	return true;
}

export async function cancelCount(db: D1Database, userid: string, id: number): Promise<boolean> {
	const at = now();
	const r = await db.prepare("UPDATE counts SET status = 'X', done_at = ?, done_by = ? WHERE id = ? AND status = 'O'").bind(at, userid, id).run();
	if (changed(r) === 0) return false;
	await audit(db, userid, { action: "COUNT.CANCEL", subject: String(id) }, at).run();
	return true;
}

// --- Transfers ---

export interface Transfer {
	id: number;
	from: number;
	to: number;
	status: "O" | "S" | "R" | "X";
	createdAt: string;
	createdBy: string;
	sentAt: string | null;
	receivedAt: string | null;
	lines: { sku: string; desc: string; weighed: boolean; qty: number; received: number | null }[];
}

export type TransferLineInput = { sku: string; qty: string }[];

// newTransfer starts a transfer of items from one store to another.
export async function newTransfer(db: D1Database, userid: string, from: number, to: number, typed: TransferLineInput): Promise<number> {
	if (from === to) throw new Invalid("to", "THE STORES MUST DIFFER");
	const lines: { sku: string; qty: number }[] = [];
	for (const [i, t] of typed.entries()) {
		const sku = text(t.sku, 14);
		if (!sku && !t.qty.trim()) continue;
		const it = sku ? await getItem(db, sku) : undefined;
		if (!it) throw new Invalid(`sku:${i}`, sku ? `ITEM ${sku} NOT FOUND` : "KEY THE ITEM'S SKU");
		const qty = readQty(t.qty, it.weighed);
		if (!qty) throw new Invalid(`qty:${i}`, it.weighed ? "KEY THE POUNDS, E.G. 12.5" : "KEY HOW MANY, 1 OR MORE");
		if (lines.some((l) => l.sku === sku)) throw new Invalid(`sku:${i}`, `${sku} IS ON THE TRANSFER TWICE`);
		lines.push({ sku, qty });
	}
	if (lines.length === 0) throw new Invalid("sku:0", "KEY AT LEAST ONE ITEM TO TRANSFER");
	const at = now();
	await db.batch([
		db.prepare("INSERT INTO transfers (from_store, to_store, created_at, created_by) VALUES (?, ?, ?, ?)").bind(from, to, at, userid),
		...lines.map((l) => db.prepare("INSERT INTO transfer_lines (transfer, sku, qty) VALUES ((SELECT MAX(id) FROM transfers WHERE created_by = ?), ?, ?)")
			.bind(userid, l.sku, l.qty)),
	]);
	const id = (await db.prepare("SELECT MAX(id) AS id FROM transfers WHERE created_by = ?").bind(userid).first<{ id: number }>())!.id;
	await audit(db, userid, { action: "TRANSFER.START", subject: String(id), store: from, detail: `to=${to} lines=${lines.length}` }, at).run();
	return id;
}

type TransferRow = Omit<Transfer, "lines">;

export async function listTransfers(db: D1Database, stores: number[], offset: number, limit: number): Promise<{ transfers: TransferRow[]; total: number }> {
	const q = stores.map(() => "?").join(",");
	const w = stores.length ? `WHERE from_store IN (${q}) OR to_store IN (${q})` : "";
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT id, from_store AS "from", to_store AS "to", status, created_at AS createdAt, created_by AS createdBy, sent_at AS sentAt,
			received_at AS receivedAt FROM transfers ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...stores, ...stores, limit, offset),
		db.prepare(`SELECT COUNT(*) AS n FROM transfers ${w}`).bind(...stores, ...stores),
	]);
	return { transfers: rows.results as unknown as TransferRow[], total: (count.results[0] as { n: number }).n };
}

export async function getTransfer(db: D1Database, id: number): Promise<Transfer | undefined> {
	const [t, l] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT id, from_store AS "from", to_store AS "to", status, created_at AS createdAt, created_by AS createdBy, sent_at AS sentAt,
			received_at AS receivedAt FROM transfers WHERE id = ?`).bind(id),
		db.prepare(`SELECT tl.sku, i.descr AS desc, i.weighed, tl.qty, tl.received FROM transfer_lines tl JOIN items i ON i.sku = tl.sku
			WHERE tl.transfer = ? ORDER BY tl.sku`).bind(id),
	]);
	const row = t.results[0] as TransferRow | undefined;
	if (!row) return undefined;
	const lines = (l.results as (Omit<Transfer["lines"][number], "weighed"> & { weighed: number })[]).map((x) => ({ ...x, weighed: x.weighed === 1 }));
	return { ...row, lines };
}

// sendTransfer takes the items off the sending store's on hand.
export async function sendTransfer(db: D1Database, userid: string, id: number): Promise<boolean> {
	const at = now();
	const from = "FROM transfers t JOIN transfer_lines tl ON tl.transfer = t.id WHERE t.id = ? AND t.status = 'O'";
	const r = await db.batch([
		db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, reason, userid)
			SELECT t.from_store, tl.sku, ?, 'XFEROUT', -tl.qty, t.id || ':' || tl.sku, 'TO ' || t.to_store, ? ${from}`).bind(at, userid, id),
		db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at) SELECT t.from_store, tl.sku, -tl.qty, ? ${from} ${ADD}`).bind(at, id),
		db.prepare("UPDATE transfers SET status = 'S', sent_at = ?, sent_by = ? WHERE id = ? AND status = 'O'").bind(at, userid, id),
	]);
	if (changed(r[2]) === 0) return false;
	await audit(db, userid, { action: "TRANSFER.SEND", subject: String(id) }, at).run();
	return true;
}

// receiveTransfer puts what arrived on the receiving store's on hand. A
// line not keyed is taken as arrived in full.
export async function receiveTransfer(db: D1Database, userid: string, id: number, received: [string, number][]): Promise<boolean> {
	const at = now();
	const from = "FROM transfers t JOIN transfer_lines tl ON tl.transfer = t.id WHERE t.id = ? AND t.status = 'S'";
	const r = await db.batch([
		...received.map(([sku, q]) => db.prepare(`UPDATE transfer_lines SET received = ? WHERE transfer = ? AND sku = ?
			AND EXISTS (SELECT 1 FROM transfers WHERE id = ? AND status = 'S')`).bind(q, id, sku, id)),
		db.prepare(`UPDATE transfer_lines SET received = qty WHERE transfer = ? AND received IS NULL
			AND EXISTS (SELECT 1 FROM transfers WHERE id = ? AND status = 'S')`).bind(id, id),
		db.prepare(`INSERT INTO stock_moves (store, sku, at, kind, qty, ref, reason, userid)
			SELECT t.to_store, tl.sku, ?, 'XFERIN', tl.received, t.id || ':' || tl.sku, 'FROM ' || t.from_store, ? ${from} AND tl.received > 0`)
			.bind(at, userid, id),
		db.prepare(`INSERT INTO stock (store, sku, on_hand, updated_at) SELECT t.to_store, tl.sku, tl.received, ? ${from} AND tl.received > 0 ${ADD}`)
			.bind(at, id),
		db.prepare("UPDATE transfers SET status = 'R', received_at = ?, received_by = ? WHERE id = ? AND status = 'S'").bind(at, userid, id),
	]);
	if (changed(r[r.length - 1]) === 0) return false;
	await audit(db, userid, { action: "TRANSFER.RECEIVE", subject: String(id) }, at).run();
	return true;
}

export async function cancelTransfer(db: D1Database, userid: string, id: number): Promise<boolean> {
	const at = now();
	const r = await db.prepare("UPDATE transfers SET status = 'X' WHERE id = ? AND status = 'O'").bind(id).run();
	if (changed(r) === 0) return false;
	await audit(db, userid, { action: "TRANSFER.CANCEL", subject: String(id) }, at).run();
	return true;
}
