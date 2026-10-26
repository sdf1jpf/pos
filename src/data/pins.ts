// Register PINs. A PIN is four digits, so it is kept only as a slow, salted
// hash, and three wrong ones in a row lock the operator out until an
// administrator sets a new one.

import { audit, Invalid, now } from "./db";

const ITERATIONS = 100_000; // the most Workers' PBKDF2 allows
export const MAX_TRIES = 3;

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

// hashPin returns "pbkdf2$<iterations>$<salt>$<hash>".
export async function hashPin(pin: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(pin, salt, ITERATIONS))}`;
}

export async function pinMatches(pin: string, stored: string | null): Promise<boolean> {
	const [kind, n, salt, hash] = (stored ?? "").split("$");
	if (kind !== "pbkdf2" || !salt || !hash) return false;
	const got = new Uint8Array(await derive(pin, unb64(salt), Number(n)));
	const want = unb64(hash);
	if (got.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
	return diff === 0;
}

export const validPin = (pin: string) => /^\d{4}$/.test(pin);

// setPin gives an employee a new PIN and unlocks them.
export async function setPin(db: D1Database, userid: string, emp: number, pin: string): Promise<void> {
	if (!validPin(pin)) throw new Invalid("pin", "PIN MUST BE 4 DIGITS");
	const at = now();
	await db.batch([
		db.prepare("UPDATE employees SET pin_hash = ?, pin_tries = 0 WHERE emp = ?").bind(await hashPin(pin), emp),
		audit(db, userid, { action: "EMP.PIN", subject: String(emp) }, at),
	]);
}

// An operator as the register knows them.
export interface Operator {
	emp: number;
	name: string;
	role: string;
	operator: string;
	stores: number[];
}

export type SignOn =
	| { ok: true; op: Operator }
	| { ok: false; why: "unknown" | "inactive" | "nopin" | "locked" | "store" | "badpin"; left?: number };

// checkPin signs an operator on at a store: the operator must be on file,
// active, allowed at the store, have a PIN and not be locked out. A wrong
// PIN counts against them; a right one clears the count.
export async function checkPin(db: D1Database, store: number, operator: string, pin: string, reg?: number): Promise<SignOn> {
	const e = await db.prepare("SELECT emp, name, role, operator, status, pin_hash AS pinHash, pin_tries AS tries FROM employees WHERE operator = ?")
		.bind(operator).first<{ emp: number; name: string; role: string; operator: string; status: string; pinHash: string | null; tries: number }>();
	if (!e) return { ok: false, why: "unknown" };
	if (e.status !== "A") return { ok: false, why: "inactive" };
	if (!e.pinHash) return { ok: false, why: "nopin" };
	if (e.tries >= MAX_TRIES) return { ok: false, why: "locked" };
	const stores = (await db.prepare("SELECT store FROM employee_stores WHERE emp = ? ORDER BY store").bind(e.emp).all<{ store: number }>())
		.results.map((r) => r.store);
	if (!(await pinMatches(pin, e.pinHash))) {
		const tries = e.tries + 1;
		await db.batch([
			db.prepare("UPDATE employees SET pin_tries = ? WHERE emp = ?").bind(tries, e.emp),
			audit(db, `OP${e.operator}`, { action: tries >= MAX_TRIES ? "PIN.LOCKED" : "PIN.BAD", subject: String(e.emp), store, reg }),
		]);
		return tries >= MAX_TRIES ? { ok: false, why: "locked" } : { ok: false, why: "badpin", left: MAX_TRIES - tries };
	}
	if (e.tries > 0) await db.prepare("UPDATE employees SET pin_tries = 0 WHERE emp = ?").bind(e.emp).run();
	if (stores.length > 0 && !stores.includes(store)) return { ok: false, why: "store" };
	return { ok: true, op: { emp: e.emp, name: e.name, role: e.role, operator: e.operator, stores } };
}

// Who may approve an override: a supervisor, manager or administrator.
export const approves = (role: string) => role === "SUPERVISOR" || role === "MANAGER" || role === "ADMIN";

// pinState says, for the employee panel, whether someone has a PIN.
export async function pinState(db: D1Database, emp: number): Promise<"NONE" | "SET" | "LOCKED"> {
	const r = await db.prepare("SELECT pin_hash AS h, pin_tries AS t FROM employees WHERE emp = ?").bind(emp).first<{ h: string | null; t: number }>();
	return !r?.h ? "NONE" : r.t >= MAX_TRIES ? "LOCKED" : "SET";
}
