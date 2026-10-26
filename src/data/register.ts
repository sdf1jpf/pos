// The register's records: which device is which register, cash drawers,
// sales and the cash that moves in and out of a drawer between sales.
// A sale is rung up in the screen's state and written once, whole, when it
// is paid for (or cancelled), in one batch with its audit rows.

import { audit, Invalid, now } from "./db";
import { priceAt } from "./items";

// A lane is a register with an operator signed on to it. It travels in the
// screen state, which the Worker signs, so it can't be made up.
export interface Lane {
	store: number;
	reg: number;
	emp: number;
	op: string; // operator ID
	name: string;
	via: "device" | "office"; // an enrolled register, or opened from the back office
	drawer?: number;
}

// The audit userid of an operator.
export const opUser = (lane: Pick<Lane, "op">) => `OP${lane.op}`;

export interface RegisterInfo {
	store: number;
	reg: number;
	name: string;
	status: string;
	storeName: string;
	taxRate: number;
}

export async function registerInfo(db: D1Database, store: number, reg: number): Promise<RegisterInfo | undefined> {
	return (await db.prepare(`SELECT r.store, r.reg, r.name, r.status, s.name AS storeName, s.tax_rate AS taxRate
		FROM registers r JOIN stores s USING (store) WHERE r.store = ? AND r.reg = ?`).bind(store, reg).first<RegisterInfo>()) ?? undefined;
}

// registerForToken finds the register enrolled with an Access service
// token's client ID.
export async function registerForToken(db: D1Database, tokenId: string): Promise<{ store: number; reg: number } | undefined> {
	return (await db.prepare("SELECT store, reg FROM registers WHERE token_id = ? AND status = 'A'")
		.bind(tokenId.toLowerCase()).first<{ store: number; reg: number }>()) ?? undefined;
}

// Drawers

// Bills and coins, largest first, as counted into or out of a drawer.
export const DENOMS = [
	{ name: "100", cents: 10000 }, { name: "50", cents: 5000 }, { name: "20", cents: 2000 }, { name: "10", cents: 1000 },
	{ name: "5", cents: 500 }, { name: "1", cents: 100 }, { name: ".25", cents: 25 }, { name: ".10", cents: 10 },
	{ name: ".05", cents: 5 }, { name: ".01", cents: 1 },
] as const;

export type Counts = Record<string, number>; // denomination name -> how many

export const countTotal = (c: Counts) => DENOMS.reduce((t, d) => t + (c[d.name] ?? 0) * d.cents, 0);

// readCounts reads a count typed as fields "n:<denomination>", or throws
// Invalid naming the bad one.
export function readCounts(fields: Record<string, string>): Counts {
	const out: Counts = {};
	for (const d of DENOMS) {
		const v = (fields[`n:${d.name}`] ?? "").trim();
		if (!v) continue;
		if (!/^\d{1,5}$/.test(v)) throw new Invalid(`n:${d.name}`, `COUNT OF ${d.name} MUST BE A WHOLE NUMBER`);
		if (Number(v) > 0) out[d.name] = Number(v);
	}
	return out;
}

export interface Drawer {
	id: number;
	store: number;
	reg: number;
	openedAt: string;
	openedBy: number;
	opening: number;
	closedAt: string | null;
}

export async function openDrawerAt(db: D1Database, store: number, reg: number): Promise<Drawer | undefined> {
	return (await db.prepare(`SELECT id, store, reg, opened_at AS openedAt, opened_by AS openedBy, opening, closed_at AS closedAt
		FROM drawers WHERE store = ? AND reg = ? AND closed_at IS NULL`).bind(store, reg).first<Drawer>()) ?? undefined;
}

export async function drawerIsOpen(db: D1Database, id: number): Promise<boolean> {
	return !!(await db.prepare("SELECT 1 FROM drawers WHERE id = ? AND closed_at IS NULL").bind(id).first());
}

// openDrawer opens the register's drawer with the float counted into it.
// If someone else opened it a moment ago, that one is used.
export async function openDrawer(db: D1Database, lane: Lane, counts: Counts): Promise<number> {
	const opening = countTotal(counts);
	const at = now();
	try {
		await db.batch([
			db.prepare("INSERT INTO drawers (store, reg, opened_at, opened_by, opening, counts) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(lane.store, lane.reg, at, lane.emp, opening, JSON.stringify(counts)),
			audit(db, opUser(lane), { action: "DRAWER.OPEN", subject: `${lane.store}/${lane.reg}`, detail: `opening=${opening}`, store: lane.store, reg: lane.reg }, at),
		]);
	} catch (e) {
		if (!(e instanceof Error && /UNIQUE constraint failed/.test(e.message))) throw e;
	}
	return (await openDrawerAt(db, lane.store, lane.reg))!.id;
}

export interface DrawerTotals {
	opening: number;
	cashSales: number; // cash kept from completed sales
	paidIn: number;
	paidOut: number;
	expected: number;
	sales: number;
	card: number;
	check: number;
}

export async function drawerTotals(db: D1Database, id: number): Promise<DrawerTotals> {
	const [d, t, m] = await db.batch<Record<string, number>>([
		db.prepare("SELECT opening FROM drawers WHERE id = ?").bind(id),
		db.prepare(`SELECT COUNT(DISTINCT s.id) AS sales,
				COALESCE(SUM(CASE WHEN t.kind = 'CASH' THEN t.amount END), 0) AS cash,
				COALESCE(SUM(CASE WHEN t.kind = 'CARD' THEN t.amount END), 0) AS card,
				COALESCE(SUM(CASE WHEN t.kind = 'CHECK' THEN t.amount END), 0) AS chk
			FROM sales s LEFT JOIN sale_tenders t ON t.sale = s.id WHERE s.drawer = ? AND s.status = 'C'`).bind(id),
		db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'PAIDIN' THEN amount END), 0) AS paidIn,
				COALESCE(SUM(CASE WHEN kind = 'PAIDOUT' THEN amount END), 0) AS paidOut
			FROM drawer_moves WHERE drawer = ?`).bind(id),
	]);
	const opening = d.results[0]?.opening ?? 0;
	const { sales, cash, card, chk } = t.results[0];
	const { paidIn, paidOut } = m.results[0];
	return { opening, cashSales: cash, paidIn, paidOut, expected: opening + cash + paidIn - paidOut, sales, card, check: chk };
}

export interface Closed {
	counted: number;
	expected: number;
	overShort: number;
}

// closeDrawer closes the drawer with what was counted out of it.
export async function closeDrawer(db: D1Database, lane: Lane, id: number, counts: Counts): Promise<Closed> {
	const counted = countTotal(counts);
	const { expected } = await drawerTotals(db, id);
	const overShort = counted - expected;
	const at = now();
	const [upd] = await db.batch([
		db.prepare(`UPDATE drawers SET closed_at = ?, closed_by = ?, counted = ?, expected = ?, over_short = ?, counts = ?
			WHERE id = ? AND closed_at IS NULL`).bind(at, lane.emp, counted, expected, overShort, JSON.stringify(counts), id),
		audit(db, opUser(lane), {
			action: "DRAWER.CLOSE", subject: String(id), detail: `counted=${counted} expected=${expected} overshort=${overShort}`,
			store: lane.store, reg: lane.reg,
		}, at),
	]);
	if ((upd.meta.changes ?? 0) === 0) throw new Invalid("", `DRAWER ${id} IS ALREADY CLOSED`);
	return { counted, expected, overShort };
}

// Paid in, paid out and no sale. token makes a move written twice count once.
export type MoveKind = "PAIDIN" | "PAIDOUT" | "NOSALE";

export async function drawerMove(db: D1Database, lane: Lane, token: string, kind: MoveKind, amount: number, reason: string): Promise<void> {
	if (!lane.drawer || !(await drawerIsOpen(db, lane.drawer))) throw new Invalid("", "NO DRAWER IS OPEN AT THIS REGISTER");
	const at = now();
	try {
		await db.batch([
			db.prepare("INSERT INTO drawer_moves (token, drawer, at, emp, kind, amount, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(token, lane.drawer, at, lane.emp, kind, amount, reason),
			audit(db, opUser(lane), {
				action: `DRAWER.${kind}`, subject: String(lane.drawer), detail: kind === "NOSALE" ? "" : `amount=${amount} reason=${reason}`,
				store: lane.store, reg: lane.reg,
			}, at),
		]);
	} catch (e) {
		if (!(e instanceof Error && /UNIQUE constraint failed/.test(e.message))) throw e;
	}
}

// Items at the register

export interface Rung {
	sku: string;
	desc: string;
	dept: number;
	price: number;
	taxable: boolean;
	weighed: boolean;
}

// findItem looks up what was keyed or scanned: a SKU, or else a UPC. The
// price is the store's.
export async function findItem(db: D1Database, store: number, code: string): Promise<Rung | "discontinued" | undefined> {
	const c = code.trim().toUpperCase();
	const r = await db.prepare(`SELECT sku, descr AS desc, dept, taxable, weighed, status FROM items
		WHERE sku = ?1 OR (upc = ?1 AND NOT EXISTS (SELECT 1 FROM items WHERE sku = ?1)) LIMIT 1`)
		.bind(c).first<{ sku: string; desc: string; dept: number; taxable: number; weighed: number; status: string }>();
	if (!r) return undefined;
	if (r.status !== "A") return "discontinued";
	const price = (await priceAt(db, store, r.sku)) ?? 0;
	return { sku: r.sku, desc: r.desc, dept: r.dept, price, taxable: r.taxable === 1, weighed: r.weighed === 1 };
}

// Sales

export interface Line {
	sku: string;
	desc: string;
	dept: number;
	qty: number; // thousandths
	price: number;
	amount: number;
	taxable: boolean;
	weighed: boolean;
	void?: boolean;
}

export type TenderKind = "CASH" | "CARD" | "CHECK";

export interface Tender {
	kind: TenderKind;
	amount: number; // toward the sale
	tendered: number; // handed over
	ref?: string;
	auth?: string;
}

export const lineAmount = (qty: number, price: number) => Math.round((qty * price) / 1000);

export interface Totals {
	items: number;
	subtotal: number;
	tax: number;
	total: number;
}

// totals adds up the lines not voided. Tax is the store's rate on the
// taxable lines, rounded once for the sale.
export function totals(lines: Line[], taxRate: number): Totals {
	const live = lines.filter((l) => !l.void);
	const subtotal = live.reduce((t, l) => t + l.amount, 0);
	const taxable = live.filter((l) => l.taxable).reduce((t, l) => t + l.amount, 0);
	const tax = Math.round((taxable * taxRate) / 100000);
	return { items: live.length, subtotal, tax, total: subtotal + tax };
}

export const paid = (tenders: Tender[]) => tenders.reduce((t, x) => t + x.amount, 0);

export class DrawerClosed extends Error {}

// writeSale writes a sale, its lines and tenders, and its audit rows, once
// per token: if the token was written already, that sale's ID comes back.
export async function writeSale(db: D1Database, lane: Lane, token: string, lines: Line[], tenders: Tender[], taxRate: number, status: "C" | "X"): Promise<number> {
	const done = await saleByToken(db, token);
	if (done) return done;
	if (!lane.drawer || !(await drawerIsOpen(db, lane.drawer))) throw new DrawerClosed();
	const t = totals(lines, taxRate);
	const change = tenders.reduce((c, x) => c + x.tendered - x.amount, 0);
	const at = now();
	const id = "(SELECT id FROM sales WHERE token = ?)";
	const a = (action: string, detail: string, approver?: string) =>
		db.prepare(`INSERT INTO audit (at, userid, store, reg, action, subject, detail, approver) VALUES (?, ?, ?, ?, ?, CAST(${id} AS TEXT), ?, ?)`)
			.bind(at, opUser(lane), lane.store, lane.reg, action, token, detail, approver ?? null);
	try {
		await db.batch([
			db.prepare(`INSERT INTO sales (token, store, reg, drawer, emp, at, subtotal, tax, total, change, status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(token, lane.store, lane.reg, lane.drawer, lane.emp, at, t.subtotal, t.tax, t.total, change, status),
			...lines.map((l, i) => db.prepare(`INSERT INTO sale_lines (sale, line, sku, descr, dept, qty, price, amount, taxable, voided)
				VALUES (${id}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(token, i + 1, l.sku, l.desc, l.dept, l.qty, l.price, l.amount, l.taxable ? 1 : 0, l.void ? 1 : 0)),
			...tenders.map((x, i) => db.prepare(`INSERT INTO sale_tenders (sale, seq, kind, amount, tendered, ref, auth)
				VALUES (${id}, ?, ?, ?, ?, ?, ?)`)
				.bind(token, i + 1, x.kind, x.amount, x.tendered, x.ref ?? "", x.auth ?? "")),
			...lines.flatMap((l, i) => (l.void ? [a("SALE.LINEVOID", `line=${i + 1} sku=${l.sku} amount=${l.amount}`)] : [])),
			a(status === "C" ? "SALE.COMPLETE" : "SALE.CANCEL", `total=${t.total} lines=${t.items}`),
		]);
	} catch (e) {
		if (!(e instanceof Error && /UNIQUE constraint failed: sales.token/.test(e.message))) throw e;
	}
	return (await saleByToken(db, token))!;
}

async function saleByToken(db: D1Database, token: string): Promise<number | undefined> {
	return (await db.prepare("SELECT id FROM sales WHERE token = ?").bind(token).first<{ id: number }>())?.id;
}

export interface Sale {
	id: number;
	store: number;
	reg: number;
	drawer: number;
	emp: number;
	operator: string;
	cashier: string;
	at: string;
	subtotal: number;
	tax: number;
	total: number;
	change: number;
	status: "C" | "X" | "V";
	voidedAt: string | null;
	lines: Line[];
	tenders: Tender[];
}

export async function getSale(db: D1Database, id: number): Promise<Sale | undefined> {
	const [s, l, t] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT s.id, s.store, s.reg, s.drawer, s.emp, COALESCE(e.operator, '') AS operator, e.name AS cashier, s.at,
				s.subtotal, s.tax, s.total, s.change, s.status, s.voided_at AS voidedAt
			FROM sales s JOIN employees e ON e.emp = s.emp WHERE s.id = ?`).bind(id),
		db.prepare(`SELECT sku, descr AS desc, dept, qty, price, amount, taxable, voided FROM sale_lines WHERE sale = ? ORDER BY line`).bind(id),
		db.prepare("SELECT kind, amount, tendered, ref, auth FROM sale_tenders WHERE sale = ? ORDER BY seq").bind(id),
	]);
	const sale = s.results[0] as Omit<Sale, "lines" | "tenders"> | undefined;
	if (!sale) return undefined;
	const lines = (l.results as (Omit<Line, "taxable" | "void" | "weighed"> & { taxable: number; voided: number })[]).map((x) => ({
		sku: x.sku, desc: x.desc, dept: x.dept, qty: x.qty, price: x.price, amount: x.amount,
		taxable: x.taxable === 1, weighed: x.qty % 1000 !== 0, ...(x.voided ? { void: true } : {}),
	}));
	return { ...sale, lines, tenders: t.results as unknown as Tender[] };
}

export interface SaleRow {
	id: number;
	at: string;
	operator: string;
	total: number;
	status: "C" | "X" | "V";
}

// listSales lists a register's sales, newest first.
export async function listSales(db: D1Database, store: number, reg: number, offset: number, limit: number): Promise<{ sales: SaleRow[]; total: number }> {
	const [rows, n] = await db.batch<SaleRow | { n: number }>([
		db.prepare(`SELECT s.id, s.at, COALESCE(e.operator, '') AS operator, s.total, s.status FROM sales s JOIN employees e ON e.emp = s.emp
			WHERE s.store = ? AND s.reg = ? ORDER BY s.id DESC LIMIT ? OFFSET ?`).bind(store, reg, limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM sales WHERE store = ? AND reg = ?").bind(store, reg),
	]);
	return { sales: rows.results as SaleRow[], total: (n.results[0] as { n: number }).n };
}

// postVoid voids a completed sale after it was paid for, with a manager's
// approval. Its cash no longer counts toward the drawer.
export async function postVoid(db: D1Database, lane: Lane, id: number, approver: { emp: number; op: string }): Promise<void> {
	const s = await getSale(db, id);
	if (!s || s.store !== lane.store || s.reg !== lane.reg) throw new Invalid("", `SALE ${id} IS NOT FROM THIS REGISTER`);
	if (s.status !== "C") throw new Invalid("", `SALE ${id} IS ${s.status === "V" ? "ALREADY VOIDED" : "CANCELLED"}`);
	if (!(await drawerIsOpen(db, s.drawer))) throw new Invalid("", `SALE ${id}'S DRAWER IS CLOSED - IT CAN'T BE VOIDED HERE`);
	const at = now();
	const [upd] = await db.batch([
		db.prepare("UPDATE sales SET status = 'V', voided_at = ?, voided_by = ?, void_approver = ? WHERE id = ? AND status = 'C'")
			.bind(at, lane.emp, approver.emp, id),
		audit(db, opUser(lane), { action: "SALE.POSTVOID", subject: String(id), detail: `total=${s.total}`, store: lane.store, reg: lane.reg, approver: `OP${approver.op}` }, at),
	]);
	if ((upd.meta.changes ?? 0) === 0) throw new Invalid("", `SALE ${id} IS ALREADY VOIDED`);
}

// Records that leave no other trace: signing on and off, opening the
// drawer with no sale.
export async function laneAudit(db: D1Database, lane: Lane, action: string, detail = ""): Promise<void> {
	await audit(db, opUser(lane), { action, subject: `${lane.store}/${lane.reg}`, detail, store: lane.store, reg: lane.reg }).run();
}
