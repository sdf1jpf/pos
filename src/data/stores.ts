// Stores and their registers.

import { parseRate } from "../money";
import { audit, changed, Conflict, diff, Invalid, now, text, unique } from "./db";

export type Status = "A" | "I";

export interface Store {
	store: number;
	name: string;
	addr1: string;
	addr2: string;
	city: string;
	state: string;
	zip: string;
	phone: string;
	taxRate: number; // thousandths of a percent: 8.25% is 8250
	discountLimit: number; // percent
	header1: string;
	header2: string;
	footer1: string;
	footer2: string;
	status: Status;
	serverToken: string; // the client ID of the service token its store server signs on with, or ""
	version: number;
	updatedAt: string;
	updatedBy: string;
}

// StoreInput is a store as typed on the screen, before it is checked.
export type StoreInput = Record<
	"store" | "name" | "addr1" | "addr2" | "city" | "state" | "zip" | "phone" | "taxRate" | "discountLimit" |
	"header1" | "header2" | "footer1" | "footer2" | "status" | "serverToken",
	string
>;

export interface Register {
	store: number;
	reg: number;
	name: string;
	status: Status;
	token: string; // the client ID of the Access service token it signs on with, or ""
}

const COLS = `store, name, addr1, addr2, city, state, zip, phone, tax_rate AS taxRate, discount_limit AS discountLimit,
	header1, header2, footer1, footer2, status, COALESCE(server_token, '') AS serverToken, version, updated_at AS updatedAt, updated_by AS updatedBy`;

export async function listStores(db: D1Database): Promise<Store[]> {
	return (await db.prepare(`SELECT ${COLS} FROM stores ORDER BY store`).all<Store>()).results;
}

export async function getStore(db: D1Database, store: number): Promise<Store | undefined> {
	return (await db.prepare(`SELECT ${COLS} FROM stores WHERE store = ?`).bind(store).first<Store>()) ?? undefined;
}

// storeNumber reads a store number, 1 to 999, or returns undefined.
export function storeNumber(s: string): number | undefined {
	const n = Number(s.trim());
	return /^\d{1,3}$/.test(s.trim()) && n >= 1 ? n : undefined;
}

// checkStore turns what was typed into the fields of a store, or throws
// Invalid naming the field that is wrong.
export function checkStore(inp: StoreInput): Omit<Store, "version" | "updatedAt" | "updatedBy"> {
	const store = storeNumber(inp.store);
	if (store === undefined) throw new Invalid("store", "STORE NUMBER MUST BE 1 TO 999");
	const name = text(inp.name, 30);
	if (!name) throw new Invalid("name", "NAME IS REQUIRED");
	const state = inp.state.trim().toUpperCase();
	if (state && !/^[A-Z]{2}$/.test(state)) throw new Invalid("state", "STATE MUST BE TWO LETTERS");
	const zip = text(inp.zip, 10);
	if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) throw new Invalid("zip", "ZIP MUST BE 12345 OR 12345-6789");
	const taxRate = parseRate(inp.taxRate || "0");
	if (taxRate === undefined || taxRate > 30000) throw new Invalid("taxRate", "TAX RATE MUST BE A PERCENTAGE, 0 TO 30, E.G. 8.25");
	const dl = inp.discountLimit.trim() || "0";
	const discountLimit = Number(dl);
	if (!/^\d{1,3}$/.test(dl) || discountLimit > 100) throw new Invalid("discountLimit", "DISCOUNT LIMIT MUST BE 0 TO 100 PERCENT");
	const status = text(inp.status, 1) || "A";
	if (status !== "A" && status !== "I") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR I (INACTIVE)");
	let serverToken: string;
	try {
		serverToken = checkToken(inp.serverToken ?? "");
	} catch (e) {
		throw e instanceof Invalid ? new Invalid("serverToken", e.message) : e;
	}
	return {
		store, name, state, zip, taxRate, discountLimit, status, serverToken,
		addr1: text(inp.addr1, 30), addr2: text(inp.addr2, 30), city: text(inp.city, 20), phone: text(inp.phone, 14),
		header1: text(inp.header1, 38), header2: text(inp.header2, 38), footer1: text(inp.footer1, 38), footer2: text(inp.footer2, 38),
	};
}

// addStore adds a store. Its number must be new.
export async function addStore(db: D1Database, userid: string, inp: StoreInput): Promise<Store> {
	const s = checkStore(inp);
	if (await getStore(db, s.store)) throw new Invalid("store", `STORE ${s.store} ALREADY EXISTS`);
	const at = now();
	await unique(db.batch([
		db.prepare(`INSERT INTO stores (store, name, addr1, addr2, city, state, zip, phone, tax_rate, discount_limit,
			header1, header2, footer1, footer2, status, server_token, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(s.store, s.name, s.addr1, s.addr2, s.city, s.state, s.zip, s.phone, s.taxRate, s.discountLimit,
				s.header1, s.header2, s.footer1, s.footer2, s.status, s.serverToken || null, at, userid),
		audit(db, userid, { action: "STORE.ADD", subject: String(s.store), store: s.store, detail: s.name }, at),
	]).catch(tokenTaken), new Invalid("store", `STORE ${s.store} ALREADY EXISTS`));
	return (await getStore(db, s.store))!;
}

// updateStore changes a store, if it is still at the version the screen read.
export async function updateStore(db: D1Database, userid: string, version: number, inp: StoreInput): Promise<Store> {
	const s = checkStore(inp);
	const before = await getStore(db, s.store);
	if (!before || before.version !== version) throw new Conflict(`STORE ${s.store} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	const at = now();
	const [upd] = await db.batch([
		db.prepare(`UPDATE stores SET name = ?, addr1 = ?, addr2 = ?, city = ?, state = ?, zip = ?, phone = ?, tax_rate = ?,
			discount_limit = ?, header1 = ?, header2 = ?, footer1 = ?, footer2 = ?, status = ?, server_token = ?,
			version = version + 1, updated_at = ?, updated_by = ? WHERE store = ? AND version = ?`)
			.bind(s.name, s.addr1, s.addr2, s.city, s.state, s.zip, s.phone, s.taxRate, s.discountLimit,
				s.header1, s.header2, s.footer1, s.footer2, s.status, s.serverToken || null, at, userid, s.store, version),
		audit(db, userid, {
			action: "STORE.UPDATE", subject: String(s.store), store: s.store,
			detail: diff(before, { ...before, ...s }, ["name", "addr1", "addr2", "city", "state", "zip", "phone", "taxRate",
				"discountLimit", "header1", "header2", "footer1", "footer2", "status", "serverToken"]),
		}, at),
	]).catch(tokenTaken);
	if (changed(upd) === 0) throw new Conflict(`STORE ${s.store} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await getStore(db, s.store))!;
}

export async function listRegisters(db: D1Database, store: number): Promise<Register[]> {
	return (await db.prepare("SELECT store, reg, name, status, COALESCE(token_id, '') AS token FROM registers WHERE store = ? ORDER BY reg").bind(store).all<Register>()).results;
}

// checkRegister checks a register's number, name and status as typed.
function checkRegister(reg: string, name: string, status: string): { reg: number; name: string; status: Status } {
	const n = Number(reg.trim());
	if (!/^\d{1,2}$/.test(reg.trim()) || n < 1) throw new Invalid("reg", "REGISTER NUMBER MUST BE 1 TO 99");
	const st = text(status, 1) || "A";
	if (st !== "A" && st !== "I") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR I (INACTIVE)");
	return { reg: n, name: text(name, 20), status: st };
}

export async function addRegister(db: D1Database, userid: string, store: number, reg: string, name: string): Promise<Register> {
	const r = checkRegister(reg, name, "A");
	const at = now();
	await unique(db.batch([
		db.prepare("INSERT INTO registers (store, reg, name, status, updated_at, updated_by) VALUES (?, ?, ?, 'A', ?, ?)")
			.bind(store, r.reg, r.name, at, userid),
		audit(db, userid, { action: "REGISTER.ADD", subject: `${store}/${r.reg}`, store, reg: r.reg, detail: r.name }, at),
	]), new Invalid("reg", `REGISTER ${r.reg} ALREADY EXISTS IN STORE ${store}`));
	return { store, reg: r.reg, name: r.name, status: "A", token: "" };
}

// tokenTaken turns a server token already another store's into an error
// on its field.
function tokenTaken(e: unknown): never {
	if (e instanceof Error && /UNIQUE constraint failed: stores.server_token/.test(e.message)) {
		throw new Invalid("serverToken", "THAT TOKEN IS ANOTHER STORE'S SERVER");
	}
	throw e;
}

// checkToken checks an Access service token client ID as typed: 32 hex
// digits, with or without the ".access" Cloudflare adds.
function checkToken(token: string): string {
	const t = token.trim().toLowerCase();
	if (!t) return "";
	if (!/^[0-9a-f]{32}(\.access)?$/.test(t)) throw new Invalid("token", "TOKEN MUST BE A SERVICE TOKEN CLIENT ID, E.G. 0123...CDEF.ACCESS");
	return t.endsWith(".access") ? t : `${t}.access`;
}

export async function updateRegister(db: D1Database, userid: string, store: number, reg: number, name: string, status: string, token: string): Promise<void> {
	const r = checkRegister(String(reg), name, status);
	const t = checkToken(token);
	const at = now();
	await unique(db.batch([
		db.prepare("UPDATE registers SET name = ?, status = ?, token_id = ?, updated_at = ?, updated_by = ? WHERE store = ? AND reg = ?")
			.bind(r.name, r.status, t || null, at, userid, store, reg),
		audit(db, userid, { action: "REGISTER.UPDATE", subject: `${store}/${reg}`, store, reg, detail: `name=${r.name} status=${r.status} token=${t}` }, at),
	]), new Invalid("token", "THAT TOKEN IS ENROLLED AT ANOTHER REGISTER"));
}
