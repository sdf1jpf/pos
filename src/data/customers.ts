// Customers, found at the register by phone number, and the gift cards
// and store credit they hold.

import { audit, changed, Conflict, diff, Invalid, now, text, unique } from "./db";
import { checkReason } from "./reasons";

export interface Customer {
	id: number;
	name: string;
	phone: string;
	email: string;
	exempt: boolean;
	exemptId: string;
}

// phoneDigits reads a phone number as its ten digits, or returns "".
export function phoneDigits(s: string): string {
	const d = s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
	return /^\d{10}$/.test(d) ? d : "";
}

export const showPhone = (d: string) => `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;

const COLS = "id, name, phone, email, tax_exempt AS exempt, exempt_id AS exemptId";

type Row = Omit<Customer, "exempt"> & { exempt: number };
const fromRow = (r: Row): Customer => ({ ...r, exempt: r.exempt === 1 });

export async function customerByPhone(db: D1Database, phone: string): Promise<Customer | undefined> {
	const r = await db.prepare(`SELECT ${COLS} FROM customers WHERE phone = ? AND status = 'A'`).bind(phone).first<Row>();
	return r ? fromRow(r) : undefined;
}

export async function getCustomer(db: D1Database, id: number): Promise<Customer | undefined> {
	const r = await db.prepare(`SELECT ${COLS} FROM customers WHERE id = ?`).bind(id).first<Row>();
	return r ? fromRow(r) : undefined;
}

export type CustomerInput = Record<"name" | "email" | "exempt" | "exemptId", string>;

export async function addCustomer(db: D1Database, userid: string, phone: string, inp: CustomerInput, store?: number): Promise<Customer> {
	const name = text(inp.name, 30);
	if (!name) throw new Invalid("name", "NAME IS REQUIRED");
	const email = inp.email.trim().toLowerCase().slice(0, 60);
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Invalid("email", "EMAIL LOOKS WRONG - E.G. NAME@EXAMPLE.COM");
	const ex = text(inp.exempt, 1) || "N";
	if (ex !== "Y" && ex !== "N") throw new Invalid("exempt", "TAX EXEMPT IS Y OR N");
	const exemptId = text(inp.exemptId, 20);
	if (ex === "Y" && !exemptId) throw new Invalid("exemptId", "KEY THE TAX EXEMPT CERTIFICATE NUMBER");
	const at = now();
	await unique(db.batch([
		db.prepare("INSERT INTO customers (name, phone, email, tax_exempt, exempt_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.bind(name, phone, email, ex === "Y" ? 1 : 0, ex === "Y" ? exemptId : "", at, userid),
		audit(db, userid, { action: "CUST.ADD", subject: phone, detail: `${name}${ex === "Y" ? ` exempt=${exemptId}` : ""}`, store }, at),
	]), new Invalid("phone", `PHONE ${showPhone(phone)} IS ANOTHER CUSTOMER'S`));
	return (await customerByPhone(db, phone))!;
}

export interface Card {
	number: string;
	kind: "GIFT" | "CREDIT";
	balance: number;
	status: "A" | "I";
}

export async function getCard(db: D1Database, number: string): Promise<Card | undefined> {
	return (await db.prepare("SELECT number, kind, balance, status FROM cards WHERE number = ?").bind(number).first<Card>()) ?? undefined;
}

// A gift card number is 8 to 19 digits, as scanned or keyed.
export const giftNumber = (s: string) => {
	const d = s.replace(/[\s-]/g, "");
	return /^\d{8,19}$/.test(d) ? d : "";
};

// newCreditNumber makes the number of new store credit.
export const newCreditNumber = () => `SC${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b % 10).join("")}`;

// --- The customer file, in the back office ---

export interface CustomerRecord extends Customer {
	status: "A" | "I";
	version: number;
	updatedAt: string;
	updatedBy: string;
}

const RECORD = `${COLS}, status, version, updated_at AS updatedAt, updated_by AS updatedBy`;

// listCustomers finds customers by a word in their name, or by phone
// (any part of the number), by name.
export async function listCustomers(db: D1Database, q: string, offset: number, limit: number): Promise<{ customers: CustomerRecord[]; total: number }> {
	const t = q.trim().toUpperCase();
	const digits = t.replace(/[\s().-]/g, "");
	const where = !t ? "" : /^\d+$/.test(digits) ? "WHERE phone LIKE ?" : "WHERE name LIKE ?";
	const arg = !t ? [] : /^\d+$/.test(digits) ? [`%${digits}%`] : [`%${t}%`];
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT ${RECORD} FROM customers ${where} ORDER BY name, id LIMIT ? OFFSET ?`).bind(...arg, limit, offset),
		db.prepare(`SELECT COUNT(*) AS n FROM customers ${where}`).bind(...arg),
	]);
	return {
		customers: (rows.results as unknown as (Row & Pick<CustomerRecord, "status" | "version" | "updatedAt" | "updatedBy">)[]).map((r) => ({ ...r, exempt: r.exempt === 1 })),
		total: (count.results[0] as { n: number }).n,
	};
}

export async function customerRecord(db: D1Database, id: number): Promise<CustomerRecord | undefined> {
	const r = await db.prepare(`SELECT ${RECORD} FROM customers WHERE id = ?`).bind(id).first<Row & Pick<CustomerRecord, "status" | "version" | "updatedAt" | "updatedBy">>();
	return r ? { ...r, exempt: r.exempt === 1 } : undefined;
}

// updateCustomer changes a customer, if they are still at the version the
// screen read.
export async function updateCustomer(
	db: D1Database, userid: string, id: number, version: number, inp: CustomerInput & { phone: string; status: string },
): Promise<CustomerRecord> {
	const name = text(inp.name, 30);
	if (!name) throw new Invalid("name", "NAME IS REQUIRED");
	const phone = phoneDigits(inp.phone);
	if (!phone) throw new Invalid("phone", "PHONE IS 10 DIGITS, E.G. 555-123-4567");
	const email = inp.email.trim().toLowerCase().slice(0, 60);
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Invalid("email", "EMAIL LOOKS WRONG - E.G. NAME@EXAMPLE.COM");
	const ex = text(inp.exempt, 1) || "N";
	if (ex !== "Y" && ex !== "N") throw new Invalid("exempt", "TAX EXEMPT IS Y OR N");
	const exemptId = text(inp.exemptId, 20);
	if (ex === "Y" && !exemptId) throw new Invalid("exemptId", "KEY THE TAX EXEMPT CERTIFICATE NUMBER");
	const status = text(inp.status, 1) || "A";
	if (status !== "A" && status !== "I") throw new Invalid("status", "STATUS IS A OR I");
	const before = await customerRecord(db, id);
	if (!before || before.version !== version) throw new Conflict(`CUSTOMER ${id} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	const after = { ...before, name, phone, email, exempt: ex === "Y", exemptId: ex === "Y" ? exemptId : "", status: status as "A" | "I" };
	const at = now();
	const [upd] = await unique(db.batch([
		db.prepare(`UPDATE customers SET name = ?, phone = ?, email = ?, tax_exempt = ?, exempt_id = ?, status = ?,
			version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
			.bind(name, phone, email, after.exempt ? 1 : 0, after.exemptId, status, at, userid, id, version),
		audit(db, userid, { action: "CUST.UPDATE", subject: String(id), detail: diff(before, after, ["name", "phone", "email", "exempt", "exemptId", "status"]) }, at),
	]), new Invalid("phone", `PHONE ${showPhone(phone)} IS ANOTHER CUSTOMER'S`));
	if (changed(upd) === 0) throw new Conflict(`CUSTOMER ${id} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await customerRecord(db, id))!;
}

export interface CustomerSale {
	id: number;
	at: string;
	store: number;
	reg: number;
	total: number;
	status: string;
}

export async function customerSales(db: D1Database, id: number, limit: number): Promise<CustomerSale[]> {
	return (await db.prepare("SELECT id, at, store, reg, total, status FROM sales WHERE customer = ? ORDER BY at DESC LIMIT ?").bind(id, limit).all<CustomerSale>()).results;
}

// --- Gift cards and store credit, in the back office ---

export interface CardRecord extends Card {
	customer: number | null;
	issuedAt: string;
	updatedAt: string;
}

// cardNumber reads a gift card or store credit number as keyed.
export function cardNumber(s: string): string {
	const t = s.trim().toUpperCase().replace(/[\s-]/g, "");
	return /^SC\d{12}$/.test(t) ? t : giftNumber(t);
}

export async function cardRecord(db: D1Database, number: string): Promise<CardRecord | undefined> {
	return (await db.prepare("SELECT number, kind, balance, status, customer, issued_at AS issuedAt, updated_at AS updatedAt FROM cards WHERE number = ?")
		.bind(number).first<CardRecord>()) ?? undefined;
}

export async function customerCards(db: D1Database, id: number): Promise<Card[]> {
	return (await db.prepare("SELECT number, kind, balance, status FROM cards WHERE customer = ? ORDER BY issued_at DESC").bind(id).all<Card>()).results;
}

export interface CardMove {
	id: number;
	at: string;
	sale: number | null;
	amount: number;
	userid: string | null;
	reason: string;
}

export async function cardMoves(db: D1Database, number: string, limit: number): Promise<CardMove[]> {
	return (await db.prepare("SELECT id, at, sale, amount, userid, reason FROM card_moves WHERE card = ? ORDER BY at DESC, id DESC LIMIT ?")
		.bind(number, limit).all<CardMove>()).results;
}

// adjustCard adds to (or takes from) a card's balance, with a reason code.
// The balance can't go below nothing.
export async function adjustCard(db: D1Database, userid: string, number: string, amount: number, reason: string): Promise<CardRecord> {
	const why = await checkReason(db, "CARD", reason);
	if (!amount) throw new Invalid("amount", "KEY AN AMOUNT TO ADD, OR -AMOUNT TO TAKE OFF");
	const card = await cardRecord(db, number);
	if (!card) throw new Invalid("card", `CARD ${number} NOT FOUND`);
	if (card.balance + amount < 0) throw new Invalid("amount", "THAT WOULD TAKE THE BALANCE BELOW 0.00");
	const at = now();
	const [upd] = await db.batch([
		db.prepare("UPDATE cards SET balance = balance + ?, updated_at = ? WHERE number = ? AND balance + ? >= 0").bind(amount, at, number, amount),
		db.prepare("INSERT INTO card_moves (card, at, amount, userid, reason) SELECT ?, ?, ?, ?, ? WHERE changes() = 1").bind(number, at, amount, userid, reason),
		audit(db, userid, { action: "CARD.ADJUST", subject: number, detail: `amount=${amount} reason=${reason} ${why}` }, at),
	]);
	if (changed(upd) === 0) throw new Invalid("amount", "THAT WOULD TAKE THE BALANCE BELOW 0.00");
	return (await cardRecord(db, number))!;
}

// setCardStatus stops a card being spent (I), or lets it be spent again (A).
export async function setCardStatus(db: D1Database, userid: string, number: string, status: "A" | "I"): Promise<void> {
	const at = now();
	await db.batch([
		db.prepare("UPDATE cards SET status = ?, updated_at = ? WHERE number = ?").bind(status, at, number),
		audit(db, userid, { action: status === "I" ? "CARD.STOP" : "CARD.START", subject: number }, at),
	]);
}
