import { describe, expect, it } from "vitest";
import { allocate, price, type Coupon, type Promo } from "../src/data/pricing";
import type { Line } from "../src/data/register";

const line = (sku: string, price: number, qty = 1000, more: Partial<Line> = {}): Line => ({
	sku, desc: sku, dept: 10, qty, price, amount: Math.round((qty * price) / 1000), taxable: false, weighed: false, ...more,
});
const promo = (p: Partial<Promo>): Promo => ({ id: 1, name: "PROMO", kind: "SALE", qty: 1, free: 0, pct: 100, price: 0, skus: [], ...p });
const coupon = (c: Partial<Coupon>): Coupon => ({ code: "C", desc: "COUPON", kind: "AMOUNT", value: 100, sku: null, dept: null, minTotal: 0, ...c });

describe("pricing", () => {
	it("allocates whole cents in proportion", () => {
		expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
		expect(allocate(10, [0, 5])).toEqual([0, 10]);
		expect(allocate(5, [0, 0])).toEqual([0, 0]);
	});

	it("gives the cheapest unit of each BOGO group free", () => {
		const p = price([line("A", 500, 2000), line("B", 300)], [promo({ kind: "BOGO", qty: 1, free: 1, skus: ["A", "B"] })], [], undefined, 0);
		// Units 5.00, 5.00, 3.00: one group of two, the second 5.00 free.
		expect(p.discount).toBe(500);
		expect(p.total).toBe(800);
	});

	it("prices a mix and match by the group", () => {
		const p = price([line("A", 300, 3000)], [promo({ kind: "MIX", qty: 2, price: 500, skus: ["A"] })], [], undefined, 0);
		expect(p.discount).toBe(100);
		expect(p.total).toBe(800);
	});

	it("takes a sale price per pound on a weighed item", () => {
		const p = price([line("APPLE", 199, 1500, { weighed: true })], [promo({ kind: "SALE", price: 149, skus: ["APPLE"] })], [], undefined, 0);
		expect(p.subtotal).toBe(299);
		expect(p.discount).toBe(75);
	});

	it("keeps promotions off overridden and discounted lines", () => {
		const promos = [promo({ kind: "SALE", price: 100, skus: ["A"] })];
		const p = price([line("A", 500, 1000, { disc: { pct: 1000 } }), line("A", 500, 1000, { override: { from: 600, reason: "PM", approver: "OP1" } })], promos, [], undefined, 0);
		expect(p.adjustments.map((a) => a.kind)).toEqual(["OVERRIDE", "LINEDISC"]);
		expect(p.discount).toBe(50);
	});

	it("applies coupons and the sale discount, and taxes what is left", () => {
		const lines = [line("A", 1000, 1000, { taxable: true }), line("B", 1000, 1000, { dept: 20 })];
		const p = price(lines, [], [coupon({ code: "DEPT", dept: 20, value: 200 }), coupon({ code: "SALE", kind: "PERCENT", value: 1000 })], { pct: 1000 }, 10000);
		// B 10.00 - 2.00 coupon = 8.00; sale 10% off each: A 9.00, B 7.20; sale
		// coupon 10% of 16.20 = 1.62 spread: A 0.90, B 0.72.
		expect(p.net).toEqual([810, 648]);
		expect(p.discount).toBe(2000 - 1458);
		expect(p.tax).toBe(81);
		expect(p.total).toBe(1458 + 81);
	});

	it("leaves out a coupon the sale is too small for", () => {
		const p = price([line("A", 1000)], [], [coupon({ minTotal: 2000 })], undefined, 0);
		expect(p.discount).toBe(0);
	});
});
