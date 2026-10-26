// Customers, found at the register by phone number, and the gift cards
// and store credit they hold.

import { audit, Invalid, now, text, unique } from "./db";

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
