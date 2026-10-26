// Reason codes: why stock was adjusted, a price overridden or a gift card
// changed. Administrators keep them (8.4); the screens that ask for one
// list the active codes.

import { audit, Invalid, now, text } from "./db";

export const KINDS = { ADJUST: "STOCK ADJUSTMENTS", OVERRIDE: "PRICE OVERRIDES", CARD: "GIFT CARD CHANGES" } as const;
export type Kind = keyof typeof KINDS;

export const isKind = (s: string): s is Kind => s in KINDS;

export interface Reason {
	code: string;
	description: string;
	status: "A" | "I";
	updatedAt: string;
	updatedBy: string;
}

export async function listReasons(db: D1Database, kind: Kind): Promise<Reason[]> {
	return (await db.prepare(`SELECT code, description, status, updated_at AS updatedAt, updated_by AS updatedBy FROM reason_codes
		WHERE kind = ? ORDER BY code`).bind(kind).all<Reason>()).results;
}

// reasons is the active codes of a kind, code to description.
export async function reasons(db: D1Database, kind: Kind): Promise<Record<string, string>> {
	const rows = (await db.prepare("SELECT code, description FROM reason_codes WHERE kind = ? AND status = 'A' ORDER BY code").bind(kind)
		.all<{ code: string; description: string }>()).results;
	return Object.fromEntries(rows.map((r) => [r.code, r.description]));
}

// reasonNote lists codes as a screen shows them beside the field.
export const reasonNote = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" ");

// checkReason returns a code's description, or refuses one that isn't an
// active code of the kind.
export async function checkReason(db: D1Database, kind: Kind, code: string, field = "reason"): Promise<string> {
	const r = await reasons(db, kind);
	if (!r[code]) throw new Invalid(field, `REASON MUST BE ${Object.keys(r).join(", ")}`);
	return r[code];
}

// saveReason adds a code or changes one's description or status.
export async function saveReason(
	db: D1Database, userid: string, kind: Kind, code: string, description: string, status: string,
	fields: { code: string; desc: string; status: string },
): Promise<void> {
	const c = text(code, 2);
	if (!/^[A-Z0-9]{1,2}$/.test(c)) throw new Invalid(fields.code, "A CODE IS 1 OR 2 LETTERS OR DIGITS");
	const d = text(description, 30);
	if (!d) throw new Invalid(fields.desc, "KEY A DESCRIPTION");
	const st = text(status, 1) || "A";
	if (st !== "A" && st !== "I") throw new Invalid(fields.status, "STATUS IS A OR I");
	const at = now();
	await db.batch([
		db.prepare(`INSERT INTO reason_codes (kind, code, description, status, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (kind, code) DO UPDATE SET description = excluded.description, status = excluded.status,
			updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(kind, c, d, st, at, userid),
		audit(db, userid, { action: "REASON.SET", subject: `${kind}/${c}`, detail: `${d} status=${st}` }, at),
	]);
}
