// Promotions and coupons, as the back office keeps them. The register
// reads them through pricing.ts.

import { cents } from "../money";
import { audit, changed, Conflict, Invalid, now, text, unique } from "./db";

// when reads a store-local time typed "YYYY-MM-DD" or "YYYY-MM-DD HH:MM",
// or "" for none (allowed only if blank is).
function when(s: string, field: string, blank: boolean): string {
	const t = s.trim();
	if (!t && blank) return "";
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(t);
	const ok = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 && Number(m[4] ?? 0) < 24 && Number(m[5] ?? 0) < 60;
	if (!ok) throw new Invalid(field, `${field === "starts" ? "STARTS" : "ENDS"} MUST BE YYYY-MM-DD OR YYYY-MM-DD HH:MM`);
	return `${m[1]}-${m[2]}-${m[3]} ${m[4] ?? "00"}:${m[5] ?? "00"}`;
}

function status(s: string): "A" | "I" {
	const st = text(s, 1) || "A";
	if (st !== "A" && st !== "I") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR I (INACTIVE)");
	return st;
}

function whole(s: string, field: string, name: string, lo: number, hi: number, dflt: number): number {
	const t = s.trim();
	if (!t) return dflt;
	if (!/^\d{1,3}$/.test(t) || Number(t) < lo || Number(t) > hi) throw new Invalid(field, `${name} MUST BE ${lo} TO ${hi}`);
	return Number(t);
}

async function storeOrAll(db: D1Database, s: string): Promise<number | null> {
	const t = s.trim();
	if (!t) return null;
	if (!/^\d{1,3}$/.test(t) || !(await db.prepare("SELECT 1 FROM stores WHERE store = ?").bind(Number(t)).first())) {
		throw new Invalid("store", `STORE ${t} NOT FOUND - BLANK FOR EVERY STORE`);
	}
	return Number(t);
}

// --- Promotions ---

export interface Promotion {
	id: number;
	name: string;
	kind: "SALE" | "BOGO" | "MIX";
	qty: number;
	free: number;
	pct: number;
	price: number;
	store: number | null;
	starts: string;
	ends: string;
	status: "A" | "I";
	skus: string[];
	version: number;
	updatedAt: string;
	updatedBy: string;
}

export type PromotionInput = Record<"name" | "kind" | "qty" | "free" | "pct" | "price" | "store" | "starts" | "ends" | "status" | "items", string>;

const PROMO_COLS = `id, name, kind, qty, free, pct, price, store, starts, ends, status, version, updated_at AS updatedAt, updated_by AS updatedBy`;

async function withSkus(db: D1Database, rows: Omit<Promotion, "skus">[]): Promise<Promotion[]> {
	if (rows.length === 0) return [];
	const links = (await db.prepare(`SELECT promo, sku FROM promotion_items WHERE promo IN (${rows.map(() => "?").join(",")}) ORDER BY sku`)
		.bind(...rows.map((r) => r.id)).all<{ promo: number; sku: string }>()).results;
	return rows.map((r) => ({ ...r, skus: links.filter((l) => l.promo === r.id).map((l) => l.sku) }));
}

export async function listPromotions(db: D1Database, offset: number, limit: number): Promise<{ promotions: Promotion[]; total: number }> {
	const [rows, n] = await db.batch<Omit<Promotion, "skus"> | { n: number }>([
		db.prepare(`SELECT ${PROMO_COLS} FROM promotions ORDER BY status, starts DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM promotions"),
	]);
	return { promotions: await withSkus(db, rows.results as Omit<Promotion, "skus">[]), total: (n.results[0] as { n: number }).n };
}

export async function getPromotion(db: D1Database, id: number): Promise<Promotion | undefined> {
	const r = await db.prepare(`SELECT ${PROMO_COLS} FROM promotions WHERE id = ?`).bind(id).first<Omit<Promotion, "skus">>();
	return r ? (await withSkus(db, [r]))[0] : undefined;
}

async function checkPromotion(db: D1Database, inp: PromotionInput): Promise<Omit<Promotion, "id" | "version" | "updatedAt" | "updatedBy">> {
	const name = text(inp.name, 24);
	if (!name) throw new Invalid("name", "NAME IS REQUIRED - IT IS PRINTED ON THE RECEIPT");
	const kind = text(inp.kind, 4) as Promotion["kind"];
	if (!["SALE", "BOGO", "MIX"].includes(kind)) throw new Invalid("kind", "KIND MUST BE SALE, BOGO OR MIX");
	const qty = whole(inp.qty, "qty", "BUY QTY", 1, 99, kind === "MIX" ? 2 : 1);
	const free = kind === "BOGO" ? whole(inp.free, "free", "GET QTY", 1, 99, 1) : 0;
	const pct = kind === "BOGO" ? whole(inp.pct, "pct", "PERCENT OFF", 1, 100, 100) : 100;
	let price = 0;
	if (kind !== "BOGO") {
		const p = cents(inp.price);
		if (!p) throw new Invalid("price", kind === "SALE" ? "KEY THE SALE PRICE, E.G. 4.99" : "KEY WHAT THE GROUP SELLS FOR, E.G. 5.00");
		price = p;
	}
	if (kind === "MIX" && qty < 2) throw new Invalid("qty", "A MIX AND MATCH IS FOR 2 OR MORE");
	const store = await storeOrAll(db, inp.store);
	const starts = when(inp.starts, "starts", false);
	const ends = when(inp.ends, "ends", true);
	if (ends && ends <= starts) throw new Invalid("ends", "ENDS MUST BE AFTER STARTS");
	const skus = [...new Set(inp.items.toUpperCase().split(/[\s,]+/).filter(Boolean))];
	if (skus.length === 0) throw new Invalid("items", "KEY THE SKUS ON PROMOTION, SEPARATED BY COMMAS");
	if (skus.length > 50) throw new Invalid("items", "A PROMOTION TAKES AT MOST 50 SKUS");
	const known = (await db.prepare(`SELECT sku FROM items WHERE sku IN (${skus.map(() => "?").join(",")})`).bind(...skus).all<{ sku: string }>())
		.results.map((r) => r.sku);
	const missing = skus.find((s) => !known.includes(s));
	if (missing) throw new Invalid("items", `SKU ${missing} NOT FOUND`);
	return { name, kind, qty, free, pct, price, store, starts, ends, status: status(inp.status), skus };
}

const links = (db: D1Database, id: number | null, skus: string[]) =>
	skus.map((s) => db.prepare(`INSERT INTO promotion_items (promo, sku) VALUES (${id === null ? "(SELECT MAX(id) FROM promotions)" : "?"}, ?)`)
		.bind(...(id === null ? [s] : [id, s])));

const promoDetail = (p: Omit<Promotion, "id" | "version" | "updatedAt" | "updatedBy">) =>
	`${p.kind} qty=${p.qty} free=${p.free} pct=${p.pct} price=${p.price} store=${p.store ?? "ALL"} ${p.starts}-${p.ends} status=${p.status} skus=${p.skus.join(",")}`.slice(0, 500);

export async function addPromotion(db: D1Database, userid: string, inp: PromotionInput): Promise<Promotion> {
	const p = await checkPromotion(db, inp);
	const at = now();
	// The batch is one transaction, so the promotion just added is the one
	// with the highest number when its items are linked.
	const [ins] = await db.batch([
		db.prepare(`INSERT INTO promotions (name, kind, qty, free, pct, price, store, starts, ends, status, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
			.bind(p.name, p.kind, p.qty, p.free, p.pct, p.price, p.store, p.starts, p.ends, p.status, at, userid),
		...links(db, null, p.skus),
		audit(db, userid, { action: "PROMO.ADD", subject: p.name, detail: promoDetail(p), store: p.store ?? undefined }, at),
	]);
	return (await getPromotion(db, (ins.results[0] as { id: number }).id))!;
}

export async function updatePromotion(db: D1Database, userid: string, id: number, version: number, inp: PromotionInput): Promise<Promotion> {
	const p = await checkPromotion(db, inp);
	const before = await getPromotion(db, id);
	if (!before || before.version !== version) throw new Conflict(`PROMOTION ${id} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	const at = now();
	const [upd] = await db.batch([
		db.prepare(`UPDATE promotions SET name = ?, kind = ?, qty = ?, free = ?, pct = ?, price = ?, store = ?, starts = ?, ends = ?, status = ?,
			version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
			.bind(p.name, p.kind, p.qty, p.free, p.pct, p.price, p.store, p.starts, p.ends, p.status, at, userid, id, version),
		db.prepare("DELETE FROM promotion_items WHERE promo = ?").bind(id),
		...links(db, id, p.skus),
		audit(db, userid, { action: "PROMO.UPDATE", subject: String(id), detail: promoDetail(p), store: p.store ?? undefined }, at),
	]);
	if (changed(upd) === 0) throw new Conflict(`PROMOTION ${id} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await getPromotion(db, id))!;
}

// --- Coupons ---

export interface CouponRec {
	code: string;
	desc: string;
	kind: "PERCENT" | "AMOUNT";
	value: number;
	sku: string;
	dept: number | null;
	minTotal: number;
	starts: string;
	ends: string;
	status: "A" | "I";
	version: number;
	updatedAt: string;
	updatedBy: string;
}

export type CouponInput = Record<"code" | "desc" | "value" | "sku" | "dept" | "minTotal" | "starts" | "ends" | "status", string>;

const COUPON_COLS = `code, descr AS desc, kind, value, COALESCE(sku, '') AS sku, dept, min_total AS minTotal, starts, ends, status, version,
	updated_at AS updatedAt, updated_by AS updatedBy`;

export async function listCoupons(db: D1Database, offset: number, limit: number): Promise<{ coupons: CouponRec[]; total: number }> {
	const [rows, n] = await db.batch<CouponRec | { n: number }>([
		db.prepare(`SELECT ${COUPON_COLS} FROM coupons ORDER BY status, code LIMIT ? OFFSET ?`).bind(limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM coupons"),
	]);
	return { coupons: rows.results as CouponRec[], total: (n.results[0] as { n: number }).n };
}

export async function getCoupon(db: D1Database, code: string): Promise<CouponRec | undefined> {
	return (await db.prepare(`SELECT ${COUPON_COLS} FROM coupons WHERE code = ?`).bind(code).first<CouponRec>()) ?? undefined;
}

// couponValue formats a coupon's value as typed: "10%" or "2.00".
export const couponValue = (c: Pick<CouponRec, "kind" | "value">) =>
	c.kind === "PERCENT" ? `${String(c.value / 100).replace(/\.0+$/, "")}%` : (c.value / 100).toFixed(2);

async function checkCoupon(db: D1Database, inp: CouponInput) {
	const code = text(inp.code, 14);
	if (!/^[A-Z0-9-]{3,14}$/.test(code)) throw new Invalid("code", "CODE MUST BE 3 TO 14 LETTERS, DIGITS OR DASHES - IT IS WHAT IS SCANNED");
	if (await db.prepare("SELECT 1 FROM items WHERE sku = ?1 OR upc = ?1").bind(code).first()) {
		throw new Invalid("code", `${code} IS AN ITEM'S SKU OR UPC - PICK ANOTHER CODE`);
	}
	const desc = text(inp.desc, 24);
	if (!desc) throw new Invalid("desc", "DESCRIPTION IS REQUIRED - IT IS PRINTED ON THE RECEIPT");
	const v = inp.value.trim();
	const pm = /^(\d{1,2})(?:\.(\d{1,2}))?\s*%$/.exec(v);
	let kind: CouponRec["kind"];
	let value: number;
	if (pm) {
		kind = "PERCENT";
		value = Number(pm[1]) * 100 + Number((pm[2] ?? "").padEnd(2, "0") || "0");
	} else {
		kind = "AMOUNT";
		value = cents(v) ?? 0;
	}
	if (value <= 0) throw new Invalid("value", "VALUE MUST BE A PERCENT UNDER 100 OR AN AMOUNT, E.G. 10% OR 2.00");
	const sku = text(inp.sku, 14);
	if (sku && !(await db.prepare("SELECT 1 FROM items WHERE sku = ?").bind(sku).first())) throw new Invalid("sku", `SKU ${sku} NOT FOUND`);
	const d = inp.dept.trim();
	let dept: number | null = null;
	if (d) {
		if (!/^\d{1,3}$/.test(d) || !(await db.prepare("SELECT 1 FROM departments WHERE dept = ?").bind(Number(d)).first())) {
			throw new Invalid("dept", `DEPARTMENT ${d} NOT FOUND`);
		}
		dept = Number(d);
	}
	if (sku && dept !== null) throw new Invalid("dept", "A COUPON IS FOR A SKU OR A DEPARTMENT, NOT BOTH");
	const minTotal = inp.minTotal.trim() ? cents(inp.minTotal) : 0;
	if (minTotal === undefined) throw new Invalid("minTotal", "MINIMUM MUST BE AN AMOUNT, E.G. 25.00");
	const starts = when(inp.starts, "starts", false);
	const ends = when(inp.ends, "ends", true);
	if (ends && ends <= starts) throw new Invalid("ends", "ENDS MUST BE AFTER STARTS");
	return { code, desc, kind, value, sku, dept, minTotal, starts, ends, status: status(inp.status) };
}

const couponDetail = (c: Awaited<ReturnType<typeof checkCoupon>>) =>
	`${couponValue(c)} sku=${c.sku} dept=${c.dept ?? ""} min=${c.minTotal} ${c.starts}-${c.ends} status=${c.status}`;

export async function addCoupon(db: D1Database, userid: string, inp: CouponInput): Promise<CouponRec> {
	const c = await checkCoupon(db, inp);
	const at = now();
	await unique(db.batch([
		db.prepare(`INSERT INTO coupons (code, descr, kind, value, sku, dept, min_total, starts, ends, status, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(c.code, c.desc, c.kind, c.value, c.sku || null, c.dept, c.minTotal, c.starts, c.ends, c.status, at, userid),
		audit(db, userid, { action: "COUPON.ADD", subject: c.code, detail: couponDetail(c) }, at),
	]), new Invalid("code", `COUPON ${c.code} ALREADY EXISTS`));
	return (await getCoupon(db, c.code))!;
}

export async function updateCoupon(db: D1Database, userid: string, code: string, version: number, inp: CouponInput): Promise<CouponRec> {
	const c = await checkCoupon(db, { ...inp, code });
	const before = await getCoupon(db, code);
	if (!before || before.version !== version) throw new Conflict(`COUPON ${code} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	const at = now();
	const [upd] = await db.batch([
		db.prepare(`UPDATE coupons SET descr = ?, kind = ?, value = ?, sku = ?, dept = ?, min_total = ?, starts = ?, ends = ?, status = ?,
			version = version + 1, updated_at = ?, updated_by = ? WHERE code = ? AND version = ?`)
			.bind(c.desc, c.kind, c.value, c.sku || null, c.dept, c.minTotal, c.starts, c.ends, c.status, at, userid, code, version),
		audit(db, userid, { action: "COUPON.UPDATE", subject: code, detail: couponDetail(c) }, at),
	]);
	if (changed(upd) === 0) throw new Conflict(`COUPON ${code} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await getCoupon(db, code))!;
}
