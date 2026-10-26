// Pricing a sale: what each line comes to after promotions, discounts and
// coupons, and the tax on what is left. It is a pure function of the lines
// and the promotions and coupons in force, so the screen, the tender and
// the sale written all agree.
//
// In order, on each line not voided:
//  1. a price override replaces the unit price (the line is rung at it);
//  2. one promotion, on lines with no override or line discount;
//  3. the line's own discount, a percent or an amount;
//  4. item and department coupons, on the lines they name;
//  5. the sale discount, a percent off every line;
//  6. sale coupons, spread over the lines by what each comes to.
// Tax is the store's rate on the taxable lines' net, rounded once.

import { dollars } from "../money";
import type { Line } from "./register";

export interface Promo {
	id: number;
	name: string;
	kind: "SALE" | "BOGO" | "MIX";
	qty: number;
	free: number;
	pct: number;
	price: number;
	skus: string[];
}

export interface Coupon {
	code: string;
	desc: string;
	kind: "PERCENT" | "AMOUNT";
	value: number; // hundredths of a percent, or cents
	sku: string | null;
	dept: number | null;
	minTotal: number;
}

export type AdjKind = "OVERRIDE" | "PROMO" | "LINEDISC" | "COUPON" | "SALEDISC";

export interface Adj {
	kind: AdjKind;
	line?: number; // 1-based; none for the sale as a whole
	code: string;
	desc: string;
	amount: number; // cents off
	approver?: string;
	whole?: boolean; // off the sale as a whole, spread over its lines
}

// A sale discount: hundredths of a percent, and who approved it if it was
// over the store's limit.
export interface SaleDisc {
	pct: number;
	approver?: string;
}

export interface Priced {
	items: number;
	subtotal: number; // the lines as rung
	discount: number; // promotions, discounts and coupons
	tax: number;
	total: number;
	net: number[]; // each line's net, 0 for a voided line
	off: number[]; // each line's discounts
	adjustments: Adj[]; // by line, then for the sale
}

// pct formats hundredths of a percent: 1000 -> "10%", 1250 -> "12.5%".
export const pctText = (p: number) => `${String(p / 100).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}%`;

// allocate splits total over weights in proportion, in whole cents, the
// remainder going to the largest shares.
export function allocate(total: number, weights: number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0);
	if (sum <= 0 || total <= 0) return weights.map(() => 0);
	const exact = weights.map((w) => (total * w) / sum);
	const out = exact.map(Math.floor);
	let left = total - out.reduce((a, b) => a + b, 0);
	const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
	for (const [, i] of order) {
		if (left <= 0) break;
		out[i]++;
		left--;
	}
	return out;
}

export function price(lines: Line[], promos: Promo[], coupons: Coupon[], sale: SaleDisc | undefined, taxRate: number): Priced {
	const live = lines.map((l) => !l.void);
	const left = lines.map((l, i) => (live[i] ? l.amount : 0));
	const adjustments: Adj[] = [];
	const take = (i: number, amount: number, a: Omit<Adj, "amount" | "line">) => {
		const n = Math.min(Math.max(amount, 0), left[i]);
		if (n <= 0) return;
		left[i] -= n;
		adjustments.push({ ...a, line: i + 1, amount: n });
	};

	lines.forEach((l, i) => {
		if (live[i] && l.override) {
			adjustments.push({
				kind: "OVERRIDE", line: i + 1, code: l.override.reason, desc: `PRICE OVERRIDE, WAS ${dollars(l.override.from)}`,
				amount: Math.max(Math.round((l.qty * l.override.from) / 1000) - l.amount, 0), approver: l.override.approver,
			});
		}
	});

	// 2. Promotions: each line takes at most one.
	const used = new Set<number>();
	for (const p of promos) {
		const eligible = lines
			.map((l, i) => i)
			.filter((i) => live[i] && !used.has(i) && !lines[i].override && !lines[i].disc && p.skus.includes(lines[i].sku));
		if (eligible.length === 0) continue;
		const off = new Map<number, number>();
		const add = (i: number, n: number) => off.set(i, (off.get(i) ?? 0) + n);
		if (p.kind === "SALE") {
			for (const i of eligible) add(i, Math.round((lines[i].qty * Math.max(lines[i].price - p.price, 0)) / 1000));
		} else {
			// Whole units only, dearest first, so the customer gets the most.
			const units = eligible
				.filter((i) => !lines[i].weighed)
				.flatMap((i) => Array.from({ length: lines[i].qty / 1000 }, () => ({ i, price: lines[i].price })))
				.sort((a, b) => b.price - a.price);
			const size = p.kind === "BOGO" ? p.qty + p.free : p.qty;
			for (let g = 0; g + size <= units.length; g += size) {
				const group = units.slice(g, g + size);
				if (p.kind === "BOGO") {
					for (const u of group.slice(p.qty)) add(u.i, Math.round((u.price * p.pct) / 100));
				} else {
					const save = group.reduce((t, u) => t + u.price, 0) - p.price;
					allocate(Math.max(save, 0), group.map((u) => u.price)).forEach((n, k) => add(group[k].i, n));
				}
			}
		}
		for (const [i, n] of off) {
			if (n <= 0) continue;
			used.add(i);
			take(i, n, { kind: "PROMO", code: String(p.id), desc: p.name });
		}
	}

	// 3. Line discounts.
	lines.forEach((l, i) => {
		if (!live[i] || !l.disc) return;
		const n = l.disc.pct !== undefined ? Math.round((left[i] * l.disc.pct) / 10000) : (l.disc.amount ?? 0);
		take(i, n, { kind: "LINEDISC", code: l.disc.pct !== undefined ? pctText(l.disc.pct) : "", desc: "DISCOUNT", approver: l.disc.approver });
	});

	// 4. Item and department coupons.
	const before = left.reduce((a, b) => a + b, 0);
	const fits = (c: Coupon) => before >= c.minTotal;
	for (const c of coupons.filter((c) => (c.sku || c.dept !== null) && fits(c))) {
		const on = lines.map((_, i) => i).filter((i) => live[i] && left[i] > 0 && (c.sku ? lines[i].sku === c.sku : lines[i].dept === c.dept));
		const base = on.map((i) => left[i]);
		const total = c.kind === "PERCENT" ? Math.round((base.reduce((a, b) => a + b, 0) * c.value) / 10000) : c.value;
		allocate(Math.min(total, base.reduce((a, b) => a + b, 0)), base).forEach((n, k) => take(on[k], n, { kind: "COUPON", code: c.code, desc: c.desc }));
	}

	// 5. The sale discount.
	if (sale && sale.pct > 0) {
		lines.forEach((_, i) => {
			if (live[i]) take(i, Math.round((left[i] * sale.pct) / 10000), { kind: "SALEDISC", code: pctText(sale.pct), desc: "SALE DISCOUNT", approver: sale.approver, whole: true });
		});
	}

	// 6. Sale coupons.
	for (const c of coupons.filter((c) => !c.sku && c.dept === null && fits(c))) {
		const base = left.slice();
		const sum = base.reduce((a, b) => a + b, 0);
		const total = Math.min(c.kind === "PERCENT" ? Math.round((sum * c.value) / 10000) : c.value, sum);
		allocate(total, base).forEach((n, i) => take(i, n, { kind: "COUPON", code: c.code, desc: c.desc, whole: true }));
	}

	const subtotal = lines.reduce((t, l, i) => t + (live[i] ? l.amount : 0), 0);
	const net = left;
	const discount = subtotal - net.reduce((a, b) => a + b, 0);
	const taxable = net.reduce((t, n, i) => t + (lines[i].taxable ? n : 0), 0);
	const tax = Math.round((taxable * taxRate) / 100000);
	const off = lines.map((l, i) => (live[i] ? l.amount - net[i] : 0));
	return { items: live.filter(Boolean).length, subtotal, discount, tax, total: subtotal - discount + tax, net, off, adjustments };
}

// What a sale needs to price it, read from the database.

const PROMO_COLS = "id, name, kind, qty, free, pct, price";

// lineAdj and wholeAdj split a sale's adjustments for showing: those of
// each line under it, and those off the whole sale added up by code.
export function wholeAdj(adjs: Adj[]): Adj[] {
	const out: Adj[] = [];
	for (const a of adjs.filter((a) => a.whole)) {
		const same = out.find((o) => o.kind === a.kind && o.code === a.code);
		if (same) same.amount += a.amount;
		else out.push({ ...a, line: undefined });
	}
	return out;
}

export const lineAdj = (adjs: Adj[], line: number) => adjs.filter((a) => !a.whole && a.line === line && a.kind !== "OVERRIDE");

// promosFor reads the promotions in force at a store now (local time,
// "YYYY-MM-DD HH:MM") for any of skus.
export async function promosFor(db: D1Database, store: number, at: string, skus: string[]): Promise<Promo[]> {
	const list = [...new Set(skus)];
	if (list.length === 0) return [];
	const marks = list.map(() => "?").join(",");
	const [ps, items] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT ${PROMO_COLS} FROM promotions p WHERE status = 'A' AND (store IS NULL OR store = ?) AND starts <= ? AND (ends = '' OR ends > ?)
			AND EXISTS (SELECT 1 FROM promotion_items i WHERE i.promo = p.id AND i.sku IN (${marks})) ORDER BY id`).bind(store, at, at, ...list),
		db.prepare(`SELECT promo, sku FROM promotion_items WHERE sku IN (${marks})`).bind(...list),
	]);
	const links = items.results as { promo: number; sku: string }[];
	return (ps.results as Omit<Promo, "skus">[]).map((p) => ({ ...p, skus: links.filter((l) => l.promo === p.id).map((l) => l.sku) }));
}

const COUPON_COLS = "code, descr AS desc, kind, value, sku, dept, min_total AS minTotal";

// couponsIn reads coupons by code that are in force now.
export async function couponsIn(db: D1Database, at: string, codes: string[]): Promise<Coupon[]> {
	if (codes.length === 0) return [];
	const rows = (await db.prepare(`SELECT ${COUPON_COLS} FROM coupons WHERE status = 'A' AND starts <= ? AND (ends = '' OR ends > ?)
		AND code IN (${codes.map(() => "?").join(",")})`).bind(at, at, ...codes).all<Coupon>()).results;
	return codes.map((c) => rows.find((r) => r.code === c)).filter((c): c is Coupon => !!c);
}

// coupon finds one coupon, in force or not, to say why it can't be taken.
export async function coupon(db: D1Database, code: string): Promise<(Coupon & { starts: string; ends: string; status: string }) | undefined> {
	return (await db.prepare(`SELECT ${COUPON_COLS}, starts, ends, status FROM coupons WHERE code = ?`).bind(code)
		.first<Coupon & { starts: string; ends: string; status: string }>()) ?? undefined;
}
