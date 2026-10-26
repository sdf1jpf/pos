// Reading the audit log: every change the back office and the registers
// made, newest first.

export interface AuditRow {
	id: number;
	at: string;
	userid: string;
	store: number | null;
	reg: number | null;
	action: string;
	subject: string;
	detail: string;
	approver: string | null;
}

export interface AuditFilter {
	store?: number;
	stores?: number[]; // the stores the reader is limited to; none is every store
	userid?: string;
	action?: string; // the start of an action, e.g. TIME. or SALE
	before?: string; // UTC time: rows before it
}

const COLS = "id, at, userid, store, reg, action, subject, detail, approver";

function where(f: AuditFilter): { sql: string; args: (string | number)[] } {
	const w: string[] = [];
	const args: (string | number)[] = [];
	const add = (sql: string, ...a: (string | number)[]) => {
		w.push(sql);
		args.push(...a);
	};
	if (f.store !== undefined) add("store = ?", f.store);
	if (f.stores?.length) add(`store IN (${f.stores.map(() => "?").join(", ")})`, ...f.stores);
	if (f.userid) add("userid = ?", f.userid);
	if (f.action) add("action LIKE ?", `${f.action.replace(/[%_]/g, "")}%`);
	if (f.before) add("at < ?", f.before);
	return { sql: w.length ? `WHERE ${w.join(" AND ")}` : "", args };
}

export async function listAudit(db: D1Database, f: AuditFilter, offset: number, limit: number): Promise<{ rows: AuditRow[]; total: number }> {
	const { sql, args } = where(f);
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT ${COLS} FROM audit ${sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
		db.prepare(`SELECT COUNT(*) AS n FROM audit ${sql}`).bind(...args),
	]);
	return { rows: rows.results as unknown as AuditRow[], total: (count.results[0] as { n: number }).n };
}

export async function getAudit(db: D1Database, id: number): Promise<AuditRow | undefined> {
	return (await db.prepare(`SELECT ${COLS} FROM audit WHERE id = ?`).bind(id).first<AuditRow>()) ?? undefined;
}
