// Customer displays and their pairing to a register. A display has a
// secret token it keeps (only its SHA-256 is stored) and, until a clerk
// pairs it, a six-digit code it shows.

import { now } from "./db";

// A code is good for this long; a display still unpaired then asks for a
// new one.
export const CODE_MINUTES = 15;

export interface Display {
	code: string | null;
	store: number | null;
	reg: number | null;
	createdAt: string;
	pairedAt: string | null;
}

export async function hashToken(token: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const stale = () => new Date(Date.now() - CODE_MINUTES * 60_000).toISOString();

// newDisplay makes a display waiting to be paired: its token, for it to
// keep, and the code to show.
export async function newDisplay(db: D1Database): Promise<{ token: string; code: string }> {
	await db.prepare("DELETE FROM displays WHERE code IS NOT NULL AND created_at < ?").bind(stale()).run();
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const hash = await hashToken(token);
	for (let i = 0; ; i++) {
		const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
		try {
			await db.prepare("INSERT INTO displays (token, code, created_at) VALUES (?, ?, ?)").bind(hash, code, now()).run();
			return { token, code };
		} catch (e) {
			// Another display has the code: draw again.
			if (i >= 4 || !String(e).includes("UNIQUE")) throw e;
		}
	}
}

// display finds a display by its token. One whose code ran out unpaired
// is gone.
export async function display(db: D1Database, token: string): Promise<(Display & { hash: string }) | undefined> {
	const hash = await hashToken(token);
	const d = await db.prepare("SELECT code, store, reg, created_at AS createdAt, paired_at AS pairedAt FROM displays WHERE token = ?")
		.bind(hash).first<Display>();
	if (!d) return undefined;
	if (d.code && d.createdAt < stale()) {
		await db.prepare("DELETE FROM displays WHERE token = ?").bind(hash).run();
		return undefined;
	}
	return { ...d, hash };
}

// pair pairs the display showing code to a register, returning its token
// hash. Undefined: no display shows the code.
export async function pair(db: D1Database, code: string, store: number, reg: number, by: string): Promise<string | undefined> {
	const d = await db.prepare("UPDATE displays SET code = NULL, store = ?, reg = ?, paired_at = ?, paired_by = ? WHERE code = ? AND created_at >= ? RETURNING token")
		.bind(store, reg, now(), by, code, stale()).first<{ token: string }>();
	return d?.token;
}

// pairedTo lists the displays paired to a register, the newest first.
export async function pairedTo(db: D1Database, store: number, reg: number): Promise<{ hash: string; pairedAt: string; pairedBy: string }[]> {
	const r = await db.prepare("SELECT token AS hash, paired_at AS pairedAt, paired_by AS pairedBy FROM displays WHERE store = ? AND reg = ? ORDER BY paired_at DESC")
		.bind(store, reg).all<{ hash: string; pairedAt: string; pairedBy: string }>();
	return r.results;
}

export async function hasDisplay(db: D1Database, store: number, reg: number): Promise<boolean> {
	return !!(await db.prepare("SELECT 1 FROM displays WHERE store = ? AND reg = ? LIMIT 1").bind(store, reg).first());
}

// unpair forgets a register's displays, returning their token hashes.
export async function unpair(db: D1Database, store: number, reg: number): Promise<string[]> {
	const r = await db.prepare("DELETE FROM displays WHERE store = ? AND reg = ? RETURNING token").bind(store, reg).all<{ token: string }>();
	return r.results.map((d) => d.token);
}
