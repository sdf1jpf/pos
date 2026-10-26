import { invalidKey, keys, label, lpad, message, msgId, pad, panel, pf, stamp, withFill } from "@greenscreen-dev/worker";
import { getCard, giftNumber, newCreditNumber, showPhone } from "../data/customers";
import { Invalid } from "../data/db";
import { coupon, couponsIn, lineAdj, price, promosFor, wholeAdj, type Priced } from "../data/pricing";
import {
	DrawerClosed, findItem, laneAudit, lineAmount, paid, registerInfo, writeSale,
	type Line, type Tender, type TenderKind,
} from "../data/register";
import type { Env } from "../env";
import { queuePosting } from "../posting";
import { cents, dollars } from "../money";
import type { PosCtx } from "../screens/types";
import { laneScreen, newSale, onLane, readQty, showQty, signOn } from "./common";
import { runCard } from "../data/cardterm";
import type { CardState, DiscountState, FunctionsState, ReceiptState, SaleState, TenderState } from "./types";

const MAX_LINES = 60;
const MAX_COUPONS = 5;

// The store's local time now, as promotions and coupons are dated.
export const localNow = (ctx: PosCtx) => stamp(ctx, new Date().toISOString());

// priceSale prices a sale with the store's tax rate and the promotions and
// coupons in force now.
export async function priceSale(ctx: PosCtx, s: SaleState): Promise<Priced> {
	const db = ctx.env.DB;
	const at = localNow(ctx);
	const [r, promos, coupons] = await Promise.all([
		registerInfo(db, s.lane.store, s.lane.reg),
		promosFor(db, s.lane.store, at, s.lines.filter((l) => !l.void).map((l) => l.sku)),
		couponsIn(db, at, s.coupons ?? []),
	]);
	return price(s.lines, promos, coupons, s.saleDisc, s.customer?.exempt ? 0 : (r?.taxRate ?? 0));
}

// One row of the sale as shown: a line as rung, or something taken off.
interface Row { n?: number; sku?: string; desc: string; qty?: string; price?: string; amount: string; t?: boolean; void?: boolean; off?: boolean }

function rows(s: SaleState, p: Priced): Row[] {
	const out: Row[] = [];
	s.lines.forEach((l, i) => {
		out.push({
			n: i + 1, sku: l.sku, desc: l.void ? `VOID ${l.desc}` : l.desc, qty: showQty(l.qty, l.weighed),
			price: `${dollars(l.price)}${l.override ? "*" : ""}`, amount: l.void ? "VOID" : dollars(l.amount), t: l.taxable && !l.void, void: l.void,
		});
		for (const a of lineAdj(p.adjustments, i + 1)) out.push({ desc: `  ${a.desc}${a.kind === "LINEDISC" && a.code ? ` ${a.code}` : ""}`, amount: dollars(-a.amount), off: true });
	});
	for (const a of wholeAdj(p.adjustments)) {
		out.push({ desc: a.kind === "COUPON" ? `COUPON ${a.code} ${a.desc}` : `${a.desc} ${a.code}`, amount: dollars(-a.amount), off: true });
	}
	return out;
}

// POS220 SALE: items keyed or scanned, one line each, with the running
// total. Enter rings the item; PF5 takes payment.

export const sale = onLane(panel<SaleState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS220", "SALE", s.lane);
		label(scr, 4, 2, "ITEM ===>");
		scr.input(4, 12, 14, "item", "", { bright: s.errField === "item" });
		label(scr, 4, 28, "QTY ===>");
		scr.input(4, 37, 8, "qty", "", { bright: s.errField === "qty" });
		label(scr, 4, 47, "LINE ===>");
		scr.input(4, 57, 2, "line", "", { numeric: true, bright: s.errField === "line" });
		if (s.customer) {
			scr.text(5, 2, `CUSTOMER ${s.customer.name} ${showPhone(s.customer.phone)}${s.customer.exempt ? "  TAX EXEMPT" : ""}`, { color: "turquoise" });
		} else {
			scr.text(5, 2, "SCAN OR KEY A SKU OR UPC; QTY IS POUNDS FOR A WEIGHED ITEM. LINE IS FOR PF6.", { color: "blue" });
		}
		scr.text(6, 2, "LN SKU            DESCRIPTION                        QTY     PRICE    AMOUNT T", { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const first = 8;
		const room = scr.rows - 5 - first + 1;
		const t = await priceSale(ctx, s);
		const shown = rows(s, t);
		shown.slice(Math.max(shown.length - room, 0)).forEach((r, i) => {
			const row = first + i;
			const color = r.void || r.off ? "yellow" : "green";
			if (r.n) scr.text(row, 2, lpad(r.n, 2), { color: "turquoise" });
			if (r.sku) scr.text(row, 5, pad(r.sku, 14), { color });
			scr.text(row, r.sku ? 20 : 5, pad(r.desc, r.sku ? 30 : 45), { color });
			if (r.qty) scr.text(row, 51, lpad(r.qty, 9), { color });
			if (r.price) scr.text(row, 61, lpad(r.price, 8), { color });
			scr.text(row, 70, lpad(r.amount, 9), { color });
			if (r.t) scr.text(row, 80, "T", { color });
		});
		if (s.lines.length === 0) scr.text(first, 5, "READY FOR THE NEXT SALE", { color: "blue" });
		scr.text(scr.rows - 4, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		scr.text(scr.rows - 3, 2, `ITEMS ${t.items}`, { color: "turquoise" });
		scr.text(scr.rows - 3, 12, `SUBTOTAL ${lpad(dollars(t.subtotal), 9)}`, { color: "turquoise" });
		if (t.discount) scr.text(scr.rows - 2, 12, `SAVINGS  ${lpad(dollars(-t.discount), 9)}`, { color: "yellow" });
		scr.text(scr.rows - 3, 34, `TAX ${lpad(dollars(t.tax), 8)}`, { color: "turquoise" });
		scr.text(scr.rows - 3, 56, `TOTAL ${lpad(dollars(t.total), 10)}`, { color: "white", bright: true });
		const p = paid(s.tenders);
		if (p > 0) scr.text(scr.rows - 2, 34, `PAID ${lpad(dollars(p), 9)}   BALANCE DUE ${lpad(dollars(t.total - p), 9)}`, { color: "yellow", bright: true });
		message(scr, s.msg ?? "");
		keys(scr, "PF2=PRICE PF3=SIGNOFF PF4=FUNC PF5=TENDER PF6=VOID LN PF9=DISCOUNT PF12=VOID");
		scr.cursorTo(s.errField ?? "item");
		return scr;
	},

	async handle(ctx, s, inp) {
		const voiding = s.voiding;
		s.msg = s.errField = s.voiding = undefined;
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const live = s.lines.filter((l) => !l.void);
		const code = (inp.fields.item ?? "").trim().toUpperCase();
		switch (inp.aid) {
			case "ENTER":
			case pf(2): {
				if (!code) {
					if (inp.aid === pf(2)) return fail("item", "2201E KEY OR SCAN THE ITEM TO PRICE");
					if (live.length > 0) s.msg = `${msgId(ctx, "2202I")} KEY AN ITEM, OR PF5 TO TENDER`;
					return s;
				}
				const it = await findItem(ctx.env.DB, s.lane.store, code);
				if (!it && inp.aid === "ENTER" && (await coupon(ctx.env.DB, code))) return takeCoupon(ctx, s, code, fail);
				if (!it) return fail("item", `2203E ITEM ${code} NOT FOUND`);
				if (it === "discontinued") return fail("item", `2204E ITEM ${code} IS DISCONTINUED - IT CAN'T BE SOLD`);
				if (inp.aid === pf(2)) {
					s.msg = `${msgId(ctx, "2205I")} ${it.sku} ${it.desc} ${dollars(it.price)}${it.weighed ? " PER LB" : ""}${it.taxable ? " TAXABLE" : ""}`;
					return s;
				}
				if (it.price <= 0) return fail("item", `2206E ITEM ${it.sku} HAS NO PRICE - SEE A MANAGER`);
				const qty = readQty(inp.fields.qty ?? "", it.weighed);
				if (qty === undefined) {
					return fail("qty", it.weighed ? `2207E ${it.desc} IS SOLD BY WEIGHT - KEY THE POUNDS, E.G. 1.25` : "2208E QTY MUST BE 1 TO 999");
				}
				if (s.lines.length >= MAX_LINES) return fail("item", `2209E A SALE HOLDS AT MOST ${MAX_LINES} LINES - TENDER THIS ONE`);
				const line: Line = { sku: it.sku, desc: it.desc, dept: it.dept, qty, price: it.price, amount: lineAmount(qty, it.price), taxable: it.taxable, weighed: it.weighed };
				s.lines.push(line);
				s.msg = `${msgId(ctx, "2210I")} ${line.desc} ${showQty(qty, it.weighed)} @ ${dollars(it.price)} = ${dollars(line.amount)}`;
				return s;
			}
			case pf(6): {
				if (s.tenders.length > 0) return fail("line", "2211E PAYMENT HAS STARTED - REMOVE IT FIRST (PF5, THEN PF6)");
				const typed = (inp.fields.line ?? "").trim();
				const n = typed ? Number(typed) : s.lines.findLastIndex((l) => !l.void) + 1;
				const l = s.lines[n - 1];
				if (!l) return fail("line", typed ? `2212E THERE IS NO LINE ${typed}` : "2213E NOTHING TO VOID");
				if (l.void) return fail("line", `2214E LINE ${n} IS ALREADY VOID`);
				l.void = true;
				s.msg = `${msgId(ctx, "2215I")} LINE ${n} VOIDED - ${l.desc}`;
				return s;
			}
			case pf(12): {
				if (s.lines.length === 0) {
					s.msg = `${msgId(ctx, "2213E")} NOTHING TO VOID`;
					return s;
				}
				if (s.tenders.length > 0) return fail("item", "2211E PAYMENT HAS STARTED - REMOVE IT FIRST (PF5, THEN PF6)");
				if (!voiding) {
					s.voiding = true;
					s.msg = `${msgId(ctx, "2216W")} PRESS PF12 AGAIN TO VOID THE WHOLE SALE`;
					return s;
				}
				try {
					const id = await writeSale(ctx.env.DB, s.lane, s.token, s.lines, [], await priceSale(ctx, s), "X", s.customer?.id);
					return newSale(s.lane, `${msgId(ctx, "2217I")} SALE ${id} VOIDED`);
				} catch (e) {
					return drawerGone(ctx, s, e);
				}
			}
			case pf(9):
				if (live.length === 0) return fail("item", "2218E RING AN ITEM FIRST");
				if (s.tenders.length > 0) return fail("item", "2211E PAYMENT HAS STARTED - REMOVE IT FIRST (PF5, THEN PF6)");
				return { p: "discount", lane: s.lane, back: s } satisfies DiscountState;
			case pf(5):
				if (live.length === 0) return fail("item", "2218E RING AN ITEM FIRST");
				return { p: "tender", lane: s.lane, back: s } satisfies TenderState;
			case pf(4):
				return { p: "functions", lane: s.lane, back: s } satisfies FunctionsState;
			case pf(3):
				if (s.lines.length > 0) return fail("item", "2219E FINISH OR VOID THE SALE FIRST");
				await laneAudit(ctx.env.DB, s.lane, "REG.SIGNOFF");
				return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2110I")} ${s.lane.name} SIGNED OFF`);
		}
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// takeCoupon adds a coupon scanned or keyed in the item field, if it is in
// force and comes off something in the sale.
async function takeCoupon(ctx: PosCtx, s: SaleState, code: string, fail: (field: string, msg: string) => SaleState) {
	const c = (await coupon(ctx.env.DB, code))!;
	s.coupons ??= []; // a sale begun before coupons came in
	const at = localNow(ctx);
	if (c.status !== "A" || c.starts > at || (c.ends && c.ends <= at)) return fail("item", `2221E COUPON ${code} IS NOT GOOD TODAY`);
	if (s.coupons.includes(code)) return fail("item", `2222E COUPON ${code} IS ALREADY TAKEN`);
	if (s.coupons.length >= MAX_COUPONS) return fail("item", `2223E A SALE TAKES AT MOST ${MAX_COUPONS} COUPONS`);
	if (s.tenders.length > 0) return fail("item", "2211E PAYMENT HAS STARTED - REMOVE IT FIRST (PF5, THEN PF6)");
	s.coupons.push(code);
	const t = await priceSale(ctx, s);
	const off = t.adjustments.filter((a) => a.kind === "COUPON" && a.code === code).reduce((n, a) => n + a.amount, 0);
	if (off === 0) {
		s.coupons.pop();
		const need = c.minTotal > 0 ? ` - THE SALE MUST COME TO ${dollars(c.minTotal)}` : c.sku ? ` - RING ITEM ${c.sku} FIRST` : c.dept !== null ? ` - RING AN ITEM FROM DEPT ${c.dept} FIRST` : "";
		return fail("item", `2224E COUPON ${code} TAKES NOTHING OFF${need}`);
	}
	s.msg = `${msgId(ctx, "2225I")} COUPON ${code} ${c.desc} - ${dollars(off)} OFF`;
	return s;
}

// A drawer closed under a sale (by a back-office close, say) can't take
// it: the operator signs on again to a new drawer.
function drawerGone(ctx: PosCtx, s: SaleState, e: unknown) {
	if (!(e instanceof DrawerClosed)) throw e;
	return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2220E")} DRAWER ${s.lane.drawer} IS CLOSED - SIGN ON AGAIN`);
}

// POS230 TENDER: payment, in as many parts as the customer likes. Cash can
// be more than is due, for change; nothing else can. A gift card or store
// credit pays what it holds. When returns make the total negative it is a
// refund instead: cash, back to a card, or store credit (only store credit
// when an item came back without a receipt). The sale is written when
// nothing is left to pay or refund.

const KINDS: Record<string, TenderKind> = {
	C: "CASH", CASH: "CASH", D: "CARD", CARD: "CARD", K: "CHECK", CHECK: "CHECK", G: "GIFT", GIFT: "GIFT", S: "CREDIT", CREDIT: "CREDIT",
};

const tenderText = (x: Tender) =>
	x.kind === "CARD" ? `CARD ****${x.ref}` : x.kind === "CHECK" ? `CHECK #${x.ref}` : x.kind === "GIFT" ? `GIFT CARD *${x.ref?.slice(-4)}`
		: x.kind === "CREDIT" ? `STORE CREDIT ${x.ref}` : "CASH";

// noReceipt is whether anything on the sale came back without a receipt.
const noReceipt = (s: SaleState) => s.lines.some((l) => !l.void && l.ret && "noReceipt" in l.ret);

export const tender = onLane(panel<TenderState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS230", "TENDER", s.lane);
		const t = await priceSale(ctx, s.back);
		const due = t.total - paid(s.back.tenders);
		const refund = due < 0;
		const row = (r: number, l: string, v: number, bright = false) => {
			label(scr, r, 4, l);
			scr.text(r, 20, lpad(dollars(v), 10), { color: bright ? "white" : "green", bright });
		};
		row(4, "SUBTOTAL", t.subtotal);
		row(5, "SAVINGS", -t.discount);
		row(6, "TAX", t.tax);
		row(7, "TOTAL", t.total, true);
		s.back.tenders.forEach((x, i) => {
			scr.text(9 + i, 4, pad(`${i + 1} ${tenderText(x)}`, 24), { color: "turquoise" });
			scr.text(9 + i, 30, lpad(dollars(x.amount), 10), { color: "green" });
		});
		const after = 9 + Math.max(s.back.tenders.length, 1);
		row(after + 1, refund ? "REFUND DUE" : "BALANCE DUE", Math.abs(due), true);
		const f = after + 3;
		label(scr, f, 2, "METHOD ===>");
		scr.input(f, 14, 5, "method", "", { bright: s.errField === "method" });
		scr.text(f, 21, refund ? (noReceipt(s.back) ? "S=STORE CREDIT" : "C=CASH  D=CARD  S=STORE CREDIT")
			: "C=CASH  D=CARD  K=CHECK  G=GIFT CARD  S=STORE CREDIT", { color: "blue" });
		label(scr, f + 1, 2, "AMOUNT ===>");
		scr.input(f + 1, 14, 9, "amount", dollars(Math.abs(due)), { bright: s.errField === "amount" });
		label(scr, f + 2, 2, "REF    ===>");
		scr.input(f + 2, 14, 19, "ref", "", { bright: s.errField === "ref" });
		scr.text(f + 2, 35, refund ? "CREDIT: BLANK FOR NEW" : "CHECK NO.  GIFT/CREDIT NO.", { color: "blue" });
		scr.text(f + 3, 2, "CARD GOES TO THE CARD TERMINAL FOR THE CUSTOMER", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=BACK TO SALE  PF6=REMOVE LAST TENDER  ENTER=APPLY");
		scr.cursorTo(s.errField ?? "method");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		const sale = s.back;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return { ...sale, msg: sale.tenders.length ? `${msgId(ctx, "2301W")} PAYMENT STARTED - BALANCE STILL DUE` : undefined };
		if (inp.aid === pf(6)) {
			const x = sale.tenders.pop();
			s.msg = x ? `${msgId(ctx, "2302I")} ${x.kind} ${dollars(x.amount)} REMOVED` : `${msgId(ctx, "2303E")} NO TENDERS TO REMOVE`;
			return s;
		}
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const priced = await priceSale(ctx, sale);
		const due = priced.total - paid(sale.tenders);
		// An even exchange: nothing to pay or refund.
		if (due === 0) return complete(ctx, s, priced, 0, false);
		const refund = due < 0;
		const owed = Math.abs(due);
		const kind = KINDS[(inp.fields.method ?? "").trim().toUpperCase()];
		if (!kind) return fail("method", "2304E METHOD MUST BE C, D, K, G OR S");
		if (refund && (kind === "CHECK" || kind === "GIFT")) return fail("method", "2313E REFUND AS C (CASH), D (CARD) OR S (STORE CREDIT)");
		if (refund && kind !== "CREDIT" && noReceipt(sale)) return fail("method", "2314E AN ITEM CAME BACK WITHOUT A RECEIPT - REFUND AS S (STORE CREDIT)");
		const amtTyped = (inp.fields.amount ?? "").trim();
		const amount = amtTyped ? cents(amtTyped) : owed;
		if (!amount || amount < 0) return fail("amount", "2305E KEY THE AMOUNT, E.G. 20.00");
		if ((refund || kind !== "CASH") && amount > owed) {
			return fail("amount", refund ? `2315E THE REFUND IS AT MOST ${dollars(owed)}` : `2306E A ${kind} CAN PAY AT MOST THE ${dollars(owed)} DUE`);
		}
		const ref = (inp.fields.ref ?? "").trim().toUpperCase();
		if (kind === "CHECK" && !/^\d{1,8}$/.test(ref)) return fail("ref", "2309E KEY THE CHECK NUMBER");
		if (sale.tenders.length >= 8) return fail("method", "2310E A SALE TAKES AT MOST 8 TENDERS");
		// The card terminal reads the card and gives the last 4 and approval.
		if (kind === "CARD") return { p: "card", lane: s.lane, back: s, amount, refund } satisfies CardState;
		let number = ref;
		if (kind === "GIFT" || kind === "CREDIT") {
			if (refund && kind === "CREDIT" && !ref) number = newCreditNumber();
			else {
				number = kind === "GIFT" ? giftNumber(ref) : /^SC\d{12}$/.test(ref) ? ref : "";
				if (!number) return fail("ref", kind === "GIFT" ? "2316E SCAN THE GIFT CARD, OR KEY ITS 8 TO 19 DIGITS" : "2317E KEY THE STORE CREDIT NUMBER, SC AND 12 DIGITS");
				const card = await getCard(ctx.env.DB, number);
				if (!card || card.kind !== kind || card.status !== "A") {
					return fail("ref", `2318E ${number} ISN'T ${kind === "GIFT" ? "A GIFT CARD" : "STORE CREDIT"} IN USE`);
				}
				if (!refund) {
					// What the card holds, less what it already pays on this sale.
					const left = card.balance - sale.tenders.filter((x) => x.ref === number).reduce((t, x) => t + x.amount, 0);
					if (left <= 0) return fail("ref", `2319E ${number} HOLDS NOTHING`);
					if (amount > left) return fail("amount", `2320E ${number} HOLDS ONLY ${dollars(left)}`);
				}
			}
		}
		const sign = refund ? -1 : 1;
		const applied = refund ? amount : Math.min(amount, owed);
		const x: Tender = {
			kind, amount: sign * applied, tendered: sign * (refund ? applied : amount),
			...(kind !== "CASH" ? { ref: number } : {}),
		};
		return apply(ctx, s, priced, x, amount);
	},
}));

// apply adds a tender, completing the sale when nothing is left to pay or
// refund. amount is what the customer handed over, for change.
function apply(ctx: PosCtx, s: TenderState, priced: Priced, x: Tender, amount: number) {
	const owed = Math.abs(priced.total - paid(s.back.tenders));
	const applied = Math.abs(x.amount);
	const refund = x.amount < 0;
	s.back.tenders.push(x);
	if (applied < owed) {
		s.msg = `${msgId(ctx, "2311I")} ${x.kind} ${dollars(applied)} ${refund ? "REFUNDED" : "APPLIED"} - ${dollars(owed - applied)} STILL ${refund ? "TO REFUND" : "DUE"}`;
		return s;
	}
	return complete(ctx, s, priced, amount - applied, true);
}

// POS231 CARD TERMINAL: the amount sent to the card terminal, waiting on
// the customer. The terminal is simulated: Enter is the customer presenting
// a card, PF10 one that is declined. Approved, the tender carries the card's
// last 4 and approval code from the terminal; declined, nothing is taken.

export const card = onLane(panel<CardState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS231", "CARD TERMINAL", s.lane);
		label(scr, 5, 4, s.refund ? "REFUND TO CARD" : "CHARGE TO CARD");
		scr.text(5, 22, lpad(dollars(s.amount), 10), { color: "white", bright: true });
		scr.text(7, 4, "+--------------------------------------+", { color: "turquoise" });
		scr.text(8, 4, "|                                      |", { color: "turquoise" });
		scr.text(9, 4, `|  ${pad(`${s.refund ? "REFUND" : "TOTAL"} $${dollars(s.amount)}`, 36)}|`, { color: "turquoise" });
		scr.text(10, 4, "|  INSERT, TAP OR SWIPE CARD           |", { color: "turquoise" });
		scr.text(11, 4, "|                                      |", { color: "turquoise" });
		scr.text(12, 4, "+--------------------------------------+", { color: "turquoise" });
		scr.text(14, 4, "THE CUSTOMER PAYS ON THE TERMINAL. IT GIVES THE REGISTER THE CARD'S", { color: "blue" });
		scr.text(15, 4, "LAST 4 AND THE APPROVAL CODE. THIS TERMINAL IS SIMULATED.", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, s.refund ? "ENTER=CUSTOMER PRESENTS CARD  PF3=CANCEL" : "ENTER=CUSTOMER PRESENTS CARD  PF10=CARD DECLINES  PF3=CANCEL");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = undefined;
		const back = s.back;
		back.msg = back.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) {
			back.msg = `${msgId(ctx, "2307W")} CARD CANCELLED - NOTHING CHARGED`;
			return back;
		}
		if (inp.aid !== "ENTER" && inp.aid !== pf(10)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const priced = await priceSale(ctx, back.back);
		const due = priced.total - paid(back.back.tenders);
		// The sale can't change while the terminal waits, but check anyway.
		if (due === 0 || due < 0 !== s.refund || s.amount > Math.abs(due)) {
			back.msg = `${msgId(ctx, "2308W")} THE BALANCE CHANGED - TENDER AGAIN`;
			return back;
		}
		const r = runCard(s.amount, s.refund, inp.aid === pf(10));
		if (!r.approved) {
			back.msg = `${msgId(ctx, "2340E")} ${r.brand} ****${r.last4} DECLINED - ${r.reason}. ASK FOR ANOTHER CARD OR METHOD`;
			back.errField = "method";
			return back;
		}
		const sign = s.refund ? -1 : 1;
		return apply(ctx, back, priced, { kind: "CARD", amount: sign * s.amount, tendered: sign * s.amount, ref: r.last4, auth: r.auth }, s.amount);
	},
}));

// complete writes the paid sale and shows its receipt. If it can't be
// written, the tender just added comes off again.
async function complete(ctx: PosCtx, s: TenderState, priced: Priced, change: number, added: boolean) {
	const sale = s.back;
	try {
		const id = await writeSale(ctx.env.DB, sale.lane, sale.token, sale.lines, sale.tenders, priced, "C", sale.customer?.id);
		await queuePosting(ctx.env, id);
		return {
			p: "receipt", lane: sale.lane, sale: id, change, back: newSale(sale.lane),
			msg: `${msgId(ctx, "2312I")} SALE ${id} COMPLETE${change > 0 ? ` - CHANGE DUE ${dollars(change)}` : ""}`,
		} satisfies ReceiptState;
	} catch (e) {
		const x = added ? sale.tenders.pop() : undefined;
		if (e instanceof Invalid) {
			s.msg = `${msgId(ctx, "2300E")} ${e.message}`;
			if (x && (x.kind === "GIFT" || x.kind === "CREDIT")) s.errField = "ref";
			return s;
		}
		return drawerGone(ctx, sale, e);
	}
}
