// What a store server and the cloud send each other. The triggers of
// migration 0011 log each change as a table and a key; what is sent is the
// row as it is now, or none for a row deleted. The cloud sends the master
// data the registers need (DOWN); a store sends what its registers wrote
// (UP). Rows are written where they land by their primary key, so a change
// sent twice is written twice to the same effect.

import { nextId, now, SPAN } from "./db";

export type Value = string | number | null;
export type Row = Record<string, Value>;
export interface Change {
	rev: number;
	tbl: string;
	key: Value[];
	row: Row | null;
}

interface Spec {
	pk: string[];
	keep?: string[]; // columns an update leaves as they are where it lands
	max?: string[]; // columns an update takes the larger of
	once?: boolean; // written when new, never changed after
	store?: boolean; // down: only the store's own rows, by its store column
	ranged?: string; // up: the column that must hold an id from the store's range
}

// The cloud's master data, in the order a new store is sent it.
export const DOWN: Record<string, Spec> = {
	stores: { pk: ["store"] },
	registers: { pk: ["store", "reg"], store: true },
	departments: { pk: ["dept"] },
	items: { pk: ["sku"] },
	prices: { pk: ["store", "sku"], store: true },
	promotions: { pk: ["id"] },
	promotion_items: { pk: ["promo", "sku"] },
	coupons: { pk: ["code"] },
	// Bad PINs keyed are counted at the store that saw them.
	employees: { pk: ["emp"], keep: ["pin_tries"] },
	employee_stores: { pk: ["emp", "store"] },
	reason_codes: { pk: ["kind", "code"] },
	customers: { pk: ["id"] },
	// A card's balance is the cloud's, less what was spent here and not yet
	// sent up: see applyDown.
	cards: { pk: ["number"] },
};

// What a store's registers write. A sale's posting and its lines' cost
// are the cloud's (it posts them to the stock ledger); a line returned at
// two places counts the larger. A card is made with nothing on it and its
// moves add up its balance, so a card spent in two stores while one was
// cut off is spent twice, and the cloud says so (CARD.OVERDRAWN).
export const UP: Record<string, Spec> = {
	customers: { pk: ["id"] },
	cards: { pk: ["number"], once: true },
	drawers: { pk: ["id"], ranged: "id" },
	sales: { pk: ["id"], ranged: "id", keep: ["posted"] },
	sale_lines: { pk: ["sale", "line"], ranged: "sale", keep: ["cost"], max: ["returned"] },
	sale_tenders: { pk: ["sale", "seq"], ranged: "sale" },
	sale_adjustments: { pk: ["sale", "seq"], ranged: "sale" },
	drawer_moves: { pk: ["id"], ranged: "id" },
	punches: { pk: ["id"], ranged: "id" },
	card_moves: { pk: ["id"], ranged: "id", once: true },
	audit: { pk: ["id"], ranged: "id", once: true },
};

export class SyncError extends Error {}

const ident = (s: string) => {
	if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new SyncError(`bad column name ${JSON.stringify(s)}`);
	return s;
};

const where = (pk: string[]) => pk.map((c) => `${c} = ?`).join(" AND ");

// changesAfter reads up to limit logged changes after rev, of the tables
// in specs, each with its row as it is now.
export async function changesAfter(db: D1Database, specs: Record<string, Spec>, rev: number, limit: number): Promise<Change[]> {
	const logged = (await db.prepare("SELECT rev, tbl, key FROM changes WHERE rev > ? ORDER BY rev LIMIT ?").bind(rev, limit)
		.all<{ rev: number; tbl: string; key: string }>()).results;
	const out: Change[] = logged.map((c) => ({ rev: c.rev, tbl: c.tbl, key: JSON.parse(c.key) as Value[], row: null }));
	const reads = out.filter((c) => specs[c.tbl]);
	if (!reads.length) return out;
	const rows = await db.batch(reads.map((c) => db.prepare(`SELECT * FROM ${c.tbl} WHERE ${where(specs[c.tbl].pk)}`).bind(...c.key)));
	reads.forEach((c, i) => (c.row = (rows[i].results[0] as Row | undefined) ?? null));
	return out;
}

// upsert writes a row by its primary key, as its spec says.
function upsert(db: D1Database, tbl: string, spec: Spec, row: Row): D1PreparedStatement {
	const cols = Object.keys(row).map(ident);
	const sets = cols.filter((c) => !spec.pk.includes(c) && !spec.keep?.includes(c))
		.map((c) => (spec.max?.includes(c) ? `${c} = MAX(${tbl}.${c}, excluded.${c})` : `${c} = excluded.${c}`));
	const then = spec.once || !sets.length ? "DO NOTHING" : `DO UPDATE SET ${sets.join(", ")}`;
	return db.prepare(`INSERT INTO ${tbl} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (${spec.pk.join(", ")}) ${then}`)
		.bind(...cols.map((c) => row[c]));
}

// The cloud's side.

// storeForServer is the store whose server signs on as userid.
export async function storeForServer(db: D1Database, userid: string): Promise<number | undefined> {
	return (await db.prepare("SELECT store FROM stores WHERE server_token = ?").bind(userid.toLowerCase()).first<{ store: number }>())?.store;
}

// pullFor is what store is sent: the master data changed after rev.
// upTo is the last change looked at, sent or not.
export async function pullFor(db: D1Database, store: number, rev: number, limit: number): Promise<{ changes: Change[]; upTo: number }> {
	const all = await changesAfter(db, DOWN, rev, limit);
	const changes = all.filter((c) => DOWN[c.tbl] && !(DOWN[c.tbl].store && c.row && c.row.store !== store));
	await db.prepare(`INSERT INTO sync_state (store, pulled, pulled_at) VALUES (?, ?, ?)
		ON CONFLICT (store) DO UPDATE SET pulled = excluded.pulled, pulled_at = excluded.pulled_at`).bind(store, rev, now()).run();
	return { changes, upTo: all.length ? all[all.length - 1].rev : rev };
}

// applyUp writes what a store sent: every row, or (if one is wrong) none.
export async function applyUp(db: D1Database, store: number, changes: Change[], upTo: number): Promise<void> {
	const base = store * SPAN;
	const at = now();
	// Card moves the cloud has already: sent before, they are not counted again.
	const moveIds = changes.filter((c) => c.tbl === "card_moves" && c.row).map((c) => Number(c.row!.id));
	const had = new Set<number>();
	for (let i = 0; i < moveIds.length; i += 50) {
		const ids = moveIds.slice(i, i + 50);
		const r = await db.prepare(`SELECT id FROM card_moves WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<{ id: number }>();
		for (const x of r.results) had.add(x.id);
	}
	const stmts: D1PreparedStatement[] = [];
	for (const c of changes) {
		const spec = UP[c.tbl];
		if (!spec) throw new SyncError(`${c.tbl} is not sent up`);
		if (!c.row) continue; // a store deletes nothing the cloud keeps
		const row: Row = { ...c.row };
		for (const k of spec.pk) if (!(k in row)) throw new SyncError(`${c.tbl} row without ${k}`);
		if (spec.ranged) {
			const id = Number(row[spec.ranged]);
			if (!(id > base && id <= base + SPAN)) throw new SyncError(`${c.tbl} ${spec.ranged} ${id} is not store ${store}'s`);
		}
		if ("store" in row && row.store !== null && row.store !== store) throw new SyncError(`${c.tbl} row of store ${row.store}`);
		if (c.tbl === "sales") row.posted = 0;
		if (c.tbl === "cards") row.balance = 0;
		if (c.tbl === "customers") await samePhone(db, row);
		stmts.push(upsert(db, c.tbl, spec, row));
		if (c.tbl === "card_moves" && !had.has(Number(row.id))) {
			had.add(Number(row.id));
			stmts.push(
				db.prepare(`INSERT INTO audit (id, at, userid, store, action, subject, detail)
					SELECT ${nextId("audit")}, ?, 'SYNC', ?, 'CARD.OVERDRAWN', number, 'balance=' || balance || ' amount=' || ? || ' move=' || ?
					FROM cards WHERE number = ? AND balance + ? < 0`)
					.bind(at, store, row.amount, row.id, row.card, row.amount),
				db.prepare("UPDATE cards SET balance = MAX(balance + ?, 0), updated_at = ? WHERE number = ?").bind(row.amount, at, row.card),
			);
		}
	}
	stmts.push(db.prepare(`INSERT INTO sync_state (store, pushed, pushed_at) VALUES (?, ?, ?)
		ON CONFLICT (store) DO UPDATE SET pushed = MAX(pushed, excluded.pushed), pushed_at = excluded.pushed_at`).bind(store, upTo, at));
	await db.batch(stmts);
}

// samePhone: a customer added at a store with a phone someone else was
// given meanwhile keeps the phone with its id after it, to be sorted out
// in the back office; phones are unique.
async function samePhone(db: D1Database, row: Row): Promise<void> {
	const other = await db.prepare("SELECT id FROM customers WHERE phone = ? AND id <> ?").bind(row.phone, row.id).first();
	if (other) row.phone = `${row.phone}-${Number(row.id) % SPAN}`;
}

// syncState is where a store's syncing stands.
export async function syncState(db: D1Database, store: number) {
	return (await db.prepare(`SELECT pushed, pulled, pushed_at AS pushedAt, pulled_at AS pulledAt, error FROM sync_state WHERE store = ?`)
		.bind(store).first<{ pushed: number; pulled: number; pushedAt: string | null; pulledAt: string | null; error: string | null }>()) ?? undefined;
}

// The store's side.

// setSite makes this database store's: what its registers write is
// numbered from the store's range and logged to send up. Run once, it
// forgets what was logged before (a store's database starts empty).
export async function setSite(db: D1Database, store: number): Promise<boolean> {
	const r = await db.prepare("SELECT base FROM site").first<{ base: number }>();
	if (r?.base === store * SPAN) return false;
	await db.batch([
		db.prepare("UPDATE site SET base = ?, applying = 0").bind(store * SPAN),
		db.prepare("DELETE FROM changes"),
		db.prepare("INSERT INTO sync_state (store) VALUES (?) ON CONFLICT (store) DO NOTHING").bind(store),
	]);
	return true;
}

// sent forgets the changes sent up to rev.
export async function sent(db: D1Database, store: number, rev: number): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM changes WHERE rev <= ?").bind(rev),
		db.prepare("UPDATE sync_state SET pushed = ?, pushed_at = ?, error = NULL WHERE store = ?").bind(rev, now(), store),
	]);
}

// applyDown writes what the cloud sent, unlogged, and moves on to upTo.
// If the batch is refused, each change is tried by itself and one that
// can't be written is skipped (and logged), so one bad row doesn't stop
// the rest coming.
export async function applyDown(db: D1Database, store: number, changes: Change[], upTo: number): Promise<string[]> {
	const stmts = (c: Change): D1PreparedStatement[] => {
		const spec = DOWN[c.tbl];
		if (!spec) return [];
		if (!c.row) return [db.prepare(`DELETE FROM ${c.tbl} WHERE ${where(spec.pk)}`).bind(...c.key)];
		const out = [upsert(db, c.tbl, spec, c.row)];
		if (c.tbl === "cards") {
			out.push(db.prepare(`UPDATE cards SET balance = MAX(? + COALESCE((SELECT SUM(m.amount) FROM card_moves m WHERE m.card = cards.number
				AND EXISTS (SELECT 1 FROM changes x WHERE x.tbl = 'card_moves' AND x.key = json_array(m.id))), 0), 0) WHERE number = ?`)
				.bind(c.row.balance, c.row.number));
		}
		return out;
	};
	const wrap = (s: D1PreparedStatement[]) => [
		db.prepare("UPDATE site SET applying = 1"),
		...s,
		db.prepare("UPDATE site SET applying = 0"),
	];
	const done = db.prepare("UPDATE sync_state SET pulled = ?, pulled_at = ? WHERE store = ?").bind(upTo, now(), store);
	try {
		await db.batch([...wrap(changes.flatMap(stmts)), done]);
		return [];
	} catch {
		const skipped: string[] = [];
		for (const c of changes) {
			try {
				await db.batch(wrap(stmts(c)));
			} catch (e) {
				skipped.push(`${c.tbl} ${JSON.stringify(c.key)}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		await done.run();
		return skipped;
	}
}

export async function syncFailed(db: D1Database, store: number, error: string): Promise<void> {
	await db.prepare("UPDATE sync_state SET error = ? WHERE store = ?").bind(error.slice(0, 300), store).run();
}
