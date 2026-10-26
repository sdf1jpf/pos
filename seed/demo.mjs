#!/usr/bin/env node
// Demo data, on top of seed/sample.sql: what a few weeks of trading leave
// behind, so the reports, the Z report, the stock ledger and the customer
// file have something to show. It prints SQL; npm run db:demo:local (or
// :remote) loads it.
//
//   - Register PINs for the sample people who have an operator ID and no
//     PIN yet: the PIN is the operator ID (CASEY BROOKS is 3001, PIN 3001).
//   - Opening stock at every store, counted in (COUNT moves, ref DEMO).
//   - Customers, two of them tax exempt, and gift cards with balances.
//   - Two weeks of sales, up to yesterday, at stores 1 and 2: two lanes a
//     day, each a drawer opened and closed in balance. The cloud's sweep
//     posts them to the stock ledger within the hour.
//
// It is safe to run again: what is there already (by PIN, stock row,
// phone, card number, drawer or sale token) is left alone, and a later run
// adds the days since. Every row it makes is marked DEMO.

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "sample.sql"), "utf8");
const out = [];
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sql = (s) => out.push(s.trim().replace(/\n\t*/g, " ") + ";");

// The same demo every run of a day: a small seeded random.
let seed = 20261026;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// What sample.sql holds: rows of a table, as arrays of values.
function rows(table) {
	const m = new RegExp(`INSERT OR IGNORE INTO ${table} \\(([^)]*)\\) VALUES\\n([\\s\\S]*?);\\n`).exec(sample);
	if (!m) throw new Error(`sample.sql has no ${table}`);
	const cols = m[1].split(",").map((c) => c.trim());
	return m[2].split("\n").filter((l) => l.trim().startsWith("(")).map((l) => {
		const vals = [...l.trim().replace(/^\(|\),?$/g, "").matchAll(/'((?:[^']|'')*)'|(NULL)|(-?\d+)/g)]
			.map((x) => (x[1] !== undefined ? x[1].replace(/''/g, "'") : x[2] ? null : Number(x[3])));
		return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
	});
}

const stores = rows("stores");
const depts = Object.fromEntries(rows("departments").map((d) => [d.dept, d]));
const items = rows("items").filter((i) => i.status === "A");
const prices = rows("prices");
const people = rows("employees").filter((e) => e.operator && e.status === "A");
const priceAt = (store, sku) => prices.find((p) => p.store === store && p.sku === sku)?.price ?? items.find((i) => i.sku === sku).price;
const taxable = (i) => (i.taxable === null ? depts[i.dept].taxable : i.taxable) === 1;
const emp = (operator) => `(SELECT emp FROM employees WHERE operator = ${q(operator)})`;

out.push("-- Demo data: made by seed/demo.mjs. Safe to run again.");

// PINs.
for (const p of people) {
	const salt = randomBytes(16);
	const hash = pbkdf2Sync(p.operator, salt, 100_000, 32, "sha256");
	sql(`UPDATE employees SET pin_hash = ${q(`pbkdf2$100000$${salt.toString("base64")}$${hash.toString("base64")}`)}
		WHERE operator = ${q(p.operator)} AND pin_hash IS NULL AND updated_by = 'SAMPLE'`);
}

// Opening stock: a few weeks' worth, more of what sells more.
const opened = "2026-10-01T12:00:00Z";
for (const s of stores) {
	for (const i of items) {
		const qty = (i.weighed ? between(90, 160) : between(70, 160)) * 1000;
		sql(`INSERT OR IGNORE INTO stock_moves (store, sku, at, kind, qty, ref, line, reason, userid)
			SELECT ${s.store}, ${q(i.sku)}, ${q(opened)}, 'COUNT', ${qty}, ${q(`DEMO-${i.sku}`)}, 0, 'OPENING STOCK', 'DEMO'
			WHERE NOT EXISTS (SELECT 1 FROM stock WHERE store = ${s.store} AND sku = ${q(i.sku)})`);
		sql(`INSERT OR IGNORE INTO stock (store, sku, on_hand, updated_at) VALUES (${s.store}, ${q(i.sku)}, ${qty}, ${q(opened)})`);
	}
}

// Customers and gift cards.
const customers = [
	["MARIA GONZALEZ", "9375550111", "", 0, ""], ["JAMES OKAFOR", "9375550112", "JOKAFOR@EXAMPLE.COM", 0, ""],
	["LINDA PARK", "9375550113", "", 0, ""], ["ROBERT HAYES", "9375550114", "", 0, ""],
	["SUSAN MILLER", "9375550115", "SMILLER@EXAMPLE.COM", 0, ""], ["DAVID CHO", "9375550116", "", 0, ""],
	["ST. MARK'S CHURCH", "9375550117", "OFFICE@STMARKS.EXAMPLE.ORG", 1, "OH-EX-104233"],
	["DAYTON PUBLIC SCHOOLS", "9375550118", "PURCHASING@DPS.EXAMPLE.ORG", 1, "OH-EX-088812"],
	["KEVIN WALSH", "9375550119", "", 0, ""], ["ANGELA BROWN", "9375550120", "", 0, ""],
];
const nextCustomer = "(SELECT COALESCE(MAX(id), 0) + 1 FROM customers WHERE id <= 10000000000)";
for (const [name, phone, email, ex, exId] of customers) {
	sql(`INSERT OR IGNORE INTO customers (id, name, phone, email, tax_exempt, exempt_id, updated_at, updated_by)
		VALUES (${nextCustomer}, ${q(name)}, ${q(phone)}, ${q(email)}, ${ex}, ${q(exId)}, ${q(opened)}, 'DEMO')`);
}
const cards = [["6006491000000017", 5000, "9375550111"], ["6006491000000025", 2500, null], ["6006491000000033", 10000, "9375550115"]];
for (const [number, balance, phone] of cards) {
	sql(`INSERT OR IGNORE INTO cards (number, kind, balance, customer, issued_at, updated_at)
		VALUES (${q(number)}, 'GIFT', ${balance}, ${phone ? `(SELECT id FROM customers WHERE phone = ${q(phone)})` : "NULL"}, ${q(opened)}, ${q(opened)})`);
}

// Two weeks of sales at stores 1 and 2, up to yesterday (UTC).
const DAYS = 14;
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const nextId = (t) => `(SELECT COALESCE(MAX(id), 0) + 1 FROM ${t} WHERE id <= 10000000000)`;
const cashiers = people.filter((p) => p.role === "CASHIER").map((p) => p.operator);
for (let d = DAYS; d >= 1; d--) {
	const day = new Date(today.getTime() - d * 86_400_000);
	const ymd = day.toISOString().slice(0, 10);
	const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
	for (const store of [1, 2]) {
		const rate = stores.find((s) => s.store === store).tax_rate;
		for (const reg of [1, 2]) {
			const op = cashiers[(d + store + reg) % cashiers.length];
			const at = (h, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000).toISOString();
			const openedAt = at(12 + reg);
			const drawer = `(SELECT id FROM drawers WHERE store = ${store} AND reg = ${reg} AND opened_at = ${q(openedAt)})`;
			const n = between(18, 30) + (weekend ? 10 : 0) - (reg === 2 ? 6 : 0);
			let cash = 0;
			const sales = [];
			for (let k = 1; k <= n; k++) {
				const lines = [];
				for (let l = between(1, 5); l > 0; l--) {
					const i = pick(items);
					const qty = i.weighed ? between(5, 30) * 100 : (rand() < 0.2 ? 2 : 1) * 1000;
					const price = priceAt(store, i.sku);
					lines.push({ i, qty, price, amount: Math.round((price * qty) / 1000) });
				}
				const subtotal = lines.reduce((t, l) => t + l.amount, 0);
				const tax = Math.round((lines.filter((l) => taxable(l.i)).reduce((t, l) => t + l.amount, 0) * rate) / 100_000);
				const total = subtotal + tax;
				const card = rand() < 0.55;
				const tendered = card ? total : Math.ceil(total / 500) * 500;
				if (!card) cash += total;
				sales.push({ token: `DEMO-${store}-${reg}-${ymd}-${k}`, at: at(12 + reg, 5 + Math.floor(((k - 1) * (9 * 60)) / n)), lines, subtotal, tax, total, card, tendered });
			}
			const closedAt = at(23, 45);
			sql(`INSERT INTO drawers (id, store, reg, opened_at, opened_by, opening, closed_at, closed_by, counted, expected, over_short, counts, day)
				SELECT ${nextId("drawers")}, ${store}, ${reg}, ${q(openedAt)}, ${emp(op)}, 15000, ${q(closedAt)}, ${emp(op)}, ${15000 + cash}, ${15000 + cash}, 0, '{}', ${q(ymd)}
				WHERE NOT EXISTS (SELECT 1 FROM drawers WHERE store = ${store} AND reg = ${reg} AND opened_at = ${q(openedAt)})`);
			for (const s of sales) {
				const id = `(SELECT id FROM sales WHERE token = ${q(s.token)})`;
				// Now and then a card sale is voided after it was paid, approved by a supervisor.
				const voided = s.card && rand() < 0.03;
				sql(`INSERT OR IGNORE INTO sales (id, token, store, reg, drawer, emp, at, subtotal, discount, tax, total, change, status, voided_at, voided_by, void_approver)
					VALUES (${nextId("sales")}, ${q(s.token)}, ${store}, ${reg}, ${drawer}, ${emp(op)}, ${q(s.at)}, ${s.subtotal}, 0, ${s.tax}, ${s.total}, ${s.tendered - s.total},
					${voided ? `'V', ${q(s.at.replace(/:\d\d\.\d+Z$/, ":59.000Z"))}, ${emp(op)}, ${emp("2101")}` : "'C', NULL, NULL, NULL"})`);
				s.lines.forEach((l, x) => sql(`INSERT OR IGNORE INTO sale_lines (sale, line, sku, descr, dept, qty, price, amount, taxable, net)
					VALUES (${id}, ${x + 1}, ${q(l.i.sku)}, ${q(l.i.descr)}, ${l.i.dept}, ${l.qty}, ${l.price}, ${l.amount}, ${taxable(l.i) ? 1 : 0}, ${l.amount})`));
				sql(`INSERT OR IGNORE INTO sale_tenders (sale, seq, kind, amount, tendered, ref, auth)
					VALUES (${id}, 1, ${s.card ? "'CARD'" : "'CASH'"}, ${s.total}, ${s.tendered}, ${q(s.card ? String(between(1000, 9999)) : "")}, ${q(s.card ? `A${between(10000, 99999)}` : "")})`);
			}
		}
	}
}

process.stdout.write(out.join("\n") + "\n");
