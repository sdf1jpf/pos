// What the data modules share: the errors a screen shows on a field, the
// audit row every change writes, and small helpers for D1.

export class Invalid extends Error {
	constructor(
		readonly field: string,
		message: string,
	) {
		super(message);
	}
}

// Conflict is a change refused because the record changed (or was added)
// since the screen read it.
export class Conflict extends Error {}

export class NotFound extends Error {}

export const now = () => new Date().toISOString();

export interface Audit {
	action: string; // e.g. ITEM.ADD
	subject: string; // the key of what changed
	detail?: string;
	store?: number;
	reg?: number;
	approver?: string;
}

// audit returns the statement that writes an audit row, to batch with the
// change it records so that both are written or neither.
export function audit(db: D1Database, userid: string, a: Audit, at = now()): D1PreparedStatement {
	return db.prepare("INSERT INTO audit (at, userid, store, reg, action, subject, detail, approver) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(at, userid, a.store ?? null, a.reg ?? null, a.action, a.subject, a.detail ?? "", a.approver ?? null);
}

// changed returns how many rows a batched statement changed.
export function changed(r: D1Result): number {
	return r.meta.changes ?? 0;
}

// text cleans a typed value: trimmed, upper case, at most max characters.
export function text(s: string | undefined, max: number): string {
	return (s ?? "").trim().toUpperCase().slice(0, max);
}

// Fields an update may change, with what they were, for the audit row.
export function diff<T extends object>(before: T, after: T, keys: (keyof T)[]): string {
	return keys.filter((k) => before[k] !== after[k]).map((k) => `${String(k)}=${String(after[k])}`).join(" ").slice(0, 500);
}

// unique waits for a write and turns a UNIQUE or PRIMARY KEY violation into
// err. A batch is one transaction, so nothing in it was written.
export async function unique<T>(write: Promise<T>, err: Error): Promise<T> {
	try {
		return await write;
	} catch (e) {
		if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) throw err;
		throw e;
	}
}
