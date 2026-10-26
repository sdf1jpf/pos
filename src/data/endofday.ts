// End of day: a store's business day, closing it with its Z report, and
// reopening it. The close itself runs as a Workflow (src/closeday.ts),
// step by step; the steps are here.

import { audit, Invalid, now } from "./db";
import { postSale } from "./stock";

// businessDay is the day a store's drawers and sales belong to now.
export async function businessDay(db: D1Database, store: number): Promise<string> {
	const r = await db.prepare("SELECT COALESCE(NULLIF(business_day, ''), date('now')) AS day FROM stores WHERE store = ?").bind(store).first<{ day: string }>();
	return r?.day ?? "";
}

export async function openDrawers(db: D1Database, store: number): Promise<{ id: number; reg: number; openedAt: string; by: string }[]> {
	return (await db.prepare(`SELECT d.id, d.reg, d.opened_at AS openedAt, e.name AS by FROM drawers d JOIN employees e ON e.emp = d.opened_by
		WHERE d.store = ? AND d.closed_at IS NULL ORDER BY d.reg`).bind(store).all<{ id: number; reg: number; openedAt: string; by: string }>()).results;
}

export type DayStatus = "R" | "C" | "O";

export interface StoreDay {
	store: number;
	day: string;
	status: DayStatus;
	workflow: string;
	closedAt: string | null;
	closedBy: string | null;
	z: Z | null;
}

export async function getDay(db: D1Database, store: number, day: string): Promise<StoreDay | undefined> {
	const r = await db.prepare(`SELECT store, day, status, workflow, closed_at AS closedAt, closed_by AS closedBy, z FROM store_days
		WHERE store = ? AND day = ?`).bind(store, day).first<Omit<StoreDay, "z"> & { z: string | null }>();
	return r ? { ...r, z: r.z ? (JSON.parse(r.z) as Z) : null } : undefined;
}

export async function listDays(db: D1Database, store: number, offset: number, limit: number): Promise<{ days: StoreDay[]; total: number }> {
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT store, day, status, workflow, closed_at AS closedAt, closed_by AS closedBy, z FROM store_days WHERE store = ?
			ORDER BY day DESC LIMIT ? OFFSET ?`).bind(store, limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM store_days WHERE store = ?").bind(store),
	]);
	const days = (rows.results as (Omit<StoreDay, "z"> & { z: string | null })[]).map((r) => ({ ...r, z: r.z ? (JSON.parse(r.z) as Z) : null }));
	return { days, total: (count.results[0] as { n: number }).n };
}

// --- The Z report ---

export interface ZDrawer {
	reg: number;
	opening: number;
	counted: number;
	expected: number;
	overShort: number;
}

export interface Z {
	store: number;
	day: string;
	at: string; // when it was made
	sales: number; // completed sales
	voids: number;
	voided: number; // their total
	cancels: number;
	merchandise: number; // what sold, after discounts
	returns: number; // what came back (negative)
	giftCards: number; // gift cards sold and loaded
	discounts: number;
	tax: number;
	total: number;
	tenders: Record<string, number>; // by kind
	creditIssued: number; // store credit refunded
	paidIn: number;
	paidOut: number;
	noSales: number;
	drawers: ZDrawer[];
	overShort: number;
	deposit: { cash: number; checks: number; total: number };
}

// zReport adds up a store's day: the sales on its drawers, their tenders,
// paid in and out, and each drawer's count.
export async function zReport(db: D1Database, store: number, day: string): Promise<Z> {
	const drawerIds = "(SELECT id FROM drawers WHERE store = ? AND day = ?)";
	const [s, l, t, m, d] = await db.batch<Record<string, number>>([
		db.prepare(`SELECT COUNT(CASE WHEN status = 'C' THEN 1 END) AS sales, COUNT(CASE WHEN status = 'V' THEN 1 END) AS voids,
			COALESCE(SUM(CASE WHEN status = 'V' THEN total END), 0) AS voided, COUNT(CASE WHEN status = 'X' THEN 1 END) AS cancels,
			COALESCE(SUM(CASE WHEN status = 'C' THEN discount END), 0) AS discounts, COALESCE(SUM(CASE WHEN status = 'C' THEN tax END), 0) AS tax,
			COALESCE(SUM(CASE WHEN status = 'C' THEN total END), 0) AS total
			FROM sales WHERE drawer IN ${drawerIds}`).bind(store, day),
		db.prepare(`SELECT COALESCE(SUM(CASE WHEN l.card IS NULL AND l.qty > 0 THEN COALESCE(l.net, l.amount) END), 0) AS merchandise,
			COALESCE(SUM(CASE WHEN l.card IS NULL AND l.qty < 0 THEN COALESCE(l.net, l.amount) END), 0) AS returns,
			COALESCE(SUM(CASE WHEN l.card IS NOT NULL THEN l.amount END), 0) AS giftCards
			FROM sales s JOIN sale_lines l ON l.sale = s.id WHERE s.status = 'C' AND l.voided = 0 AND s.drawer IN ${drawerIds}`).bind(store, day),
		db.prepare(`SELECT t.kind, SUM(t.amount) AS amount, SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) AS refunded
			FROM sales s JOIN sale_tenders t ON t.sale = s.id WHERE s.status = 'C' AND s.drawer IN ${drawerIds} GROUP BY t.kind`).bind(store, day),
		db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'PAIDIN' THEN amount END), 0) AS paidIn,
			COALESCE(SUM(CASE WHEN kind = 'PAIDOUT' THEN amount END), 0) AS paidOut, COUNT(CASE WHEN kind = 'NOSALE' THEN 1 END) AS noSales
			FROM drawer_moves WHERE drawer IN ${drawerIds}`).bind(store, day),
		db.prepare(`SELECT reg, opening, COALESCE(counted, 0) AS counted, COALESCE(expected, 0) AS expected, COALESCE(over_short, 0) AS overShort
			FROM drawers WHERE store = ? AND day = ? ORDER BY reg, id`).bind(store, day),
	]);
	const sales = s.results[0];
	const lines = l.results[0];
	const tenders: Record<string, number> = {};
	let creditIssued = 0;
	for (const r of t.results as unknown as { kind: string; amount: number; refunded: number }[]) {
		tenders[r.kind] = r.amount;
		if (r.kind === "CREDIT") creditIssued = -r.refunded;
	}
	const moves = m.results[0];
	const drawers = d.results as unknown as ZDrawer[];
	const cash = drawers.reduce((x, dr) => x + dr.counted - dr.opening, 0);
	const checks = tenders.CHECK ?? 0;
	return {
		store, day, at: now(),
		sales: sales.sales, voids: sales.voids, voided: sales.voided, cancels: sales.cancels,
		merchandise: lines.merchandise, returns: lines.returns, giftCards: lines.giftCards,
		discounts: sales.discounts, tax: sales.tax, total: sales.total,
		tenders, creditIssued,
		paidIn: moves.paidIn, paidOut: moves.paidOut, noSales: moves.noSales,
		drawers, overShort: drawers.reduce((x, dr) => x + dr.overShort, 0),
		deposit: { cash, checks, total: cash + checks },
	};
}

// --- Closing and reopening ---

// startClose marks a day as closing, under a Workflow instance. A day
// already closed can't be closed again until it is reopened; a close that
// failed part way can be started again.
export async function startClose(db: D1Database, userid: string, store: number, day: string, workflow: string): Promise<void> {
	if ((await openDrawers(db, store)).length > 0) throw new Invalid("", "CLOSE EVERY DRAWER FIRST");
	const r = await db.prepare(`INSERT INTO store_days (store, day, status, workflow) VALUES (?, ?, 'R', ?)
		ON CONFLICT (store, day) DO UPDATE SET status = 'R', workflow = excluded.workflow WHERE status <> 'C'`).bind(store, day, workflow).run();
	if ((r.meta.changes ?? 0) === 0) throw new Invalid("", `DAY ${day} IS ALREADY CLOSED`);
	await audit(db, userid, { action: "DAY.CLOSE.START", subject: `${store}/${day}`, store, detail: `workflow=${workflow}` }).run();
}

// postDay posts the day's sales to the stock ledger, so nothing is left
// waiting on the queue.
export async function postDay(db: D1Database, store: number, day: string): Promise<number> {
	const ids = (await db.prepare(`SELECT id FROM sales WHERE drawer IN (SELECT id FROM drawers WHERE store = ? AND day = ?)
		AND ((posted = 0 AND status IN ('C', 'V')) OR (posted = 1 AND status = 'V'))`).bind(store, day).all<{ id: number }>()).results;
	for (const { id } of ids) await postSale(db, id);
	return ids.length;
}

// finishClose writes the Z report, closes the day and moves the store on
// to next (if the day closed is the store's business day).
export async function finishClose(db: D1Database, userid: string, z: Z, next: string): Promise<void> {
	const at = now();
	await db.batch([
		db.prepare("UPDATE store_days SET status = 'C', z = ?, closed_at = ?, closed_by = ? WHERE store = ? AND day = ? AND status = 'R'")
			.bind(JSON.stringify(z), at, userid, z.store, z.day),
		db.prepare("UPDATE stores SET business_day = ? WHERE store = ? AND COALESCE(NULLIF(business_day, ''), date('now')) = ?").bind(next, z.store, z.day),
		audit(db, userid, { action: "DAY.CLOSE", subject: `${z.store}/${z.day}`, store: z.store, detail: `total=${z.total} overshort=${z.overShort} next=${next}` }, at),
	]);
}

// nextDay is the business day after day: the day after, or today if the
// store has fallen behind.
export function nextDay(day: string, today: string): string {
	const after = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
	return today > after ? today : after;
}

// reopenDay opens a store's last closed day again, and makes it the store's
// business day, so drawers can be opened and sales rung on it. Only before
// anything has happened on the day after.
export async function reopenDay(db: D1Database, userid: string, store: number): Promise<string> {
	const last = await db.prepare("SELECT day FROM store_days WHERE store = ? AND status = 'C' ORDER BY day DESC LIMIT 1").bind(store).first<{ day: string }>();
	if (!last) throw new Invalid("", "NO DAY HAS BEEN CLOSED YET");
	const today = await businessDay(db, store);
	if (await db.prepare("SELECT 1 FROM drawers WHERE store = ? AND day > ?").bind(store, last.day).first()) {
		throw new Invalid("", `DRAWERS HAVE BEEN OPENED SINCE ${last.day} - IT CAN'T BE REOPENED`);
	}
	const at = now();
	await db.batch([
		db.prepare("UPDATE store_days SET status = 'O' WHERE store = ? AND day = ? AND status = 'C'").bind(store, last.day),
		db.prepare("UPDATE stores SET business_day = ? WHERE store = ?").bind(last.day, store),
		audit(db, userid, { action: "DAY.REOPEN", subject: `${store}/${last.day}`, store, detail: `was=${today}` }, at),
	]);
	return last.day;
}
