import { invalidKey, keys, label, lpad, message, msgId, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import {
	DrawerClosed, findItem, laneAudit, lineAmount, paid, registerInfo, totals, writeSale,
	type Line, type Tender, type TenderKind,
} from "../data/register";
import type { Env } from "../env";
import { cents, dollars } from "../money";
import type { PosCtx } from "../screens/types";
import { laneScreen, newSale, onLane, readQty, showQty, signOn } from "./common";
import type { FunctionsState, ReceiptState, SaleState, TenderState } from "./types";

const MAX_LINES = 60;

async function taxRate(ctx: PosCtx, s: { lane: { store: number; reg: number } }): Promise<number> {
	return (await registerInfo(ctx.env.DB, s.lane.store, s.lane.reg))?.taxRate ?? 0;
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
		scr.text(5, 2, "SCAN OR KEY A SKU OR UPC; QTY IS POUNDS FOR A WEIGHED ITEM. LINE IS FOR PF6.", { color: "blue" });
		scr.text(6, 2, "LN SKU            DESCRIPTION                        QTY     PRICE    AMOUNT T", { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const first = 8;
		const room = scr.rows - 5 - first + 1;
		const from = Math.max(s.lines.length - room, 0);
		s.lines.slice(from).forEach((l, i) => {
			const row = first + i;
			const color = l.void ? "yellow" : "green";
			scr.text(row, 2, lpad(from + i + 1, 2), { color: "turquoise" });
			scr.text(row, 5, pad(l.sku, 14), { color });
			scr.text(row, 20, pad(l.void ? `VOID ${l.desc}` : l.desc, 30), { color });
			scr.text(row, 51, lpad(showQty(l.qty, l.weighed), 9), { color });
			scr.text(row, 61, lpad(dollars(l.price), 8), { color });
			scr.text(row, 70, lpad(l.void ? "VOID" : dollars(l.amount), 9), { color });
			if (l.taxable && !l.void) scr.text(row, 80, "T", { color });
		});
		if (s.lines.length === 0) scr.text(first, 5, "READY FOR THE NEXT SALE", { color: "blue" });
		const t = totals(s.lines, await taxRate(ctx, s));
		scr.text(scr.rows - 4, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		scr.text(scr.rows - 3, 2, `ITEMS ${t.items}`, { color: "turquoise" });
		scr.text(scr.rows - 3, 14, `SUBTOTAL ${lpad(dollars(t.subtotal), 9)}`, { color: "turquoise" });
		scr.text(scr.rows - 3, 36, `TAX ${lpad(dollars(t.tax), 8)}`, { color: "turquoise" });
		scr.text(scr.rows - 3, 56, `TOTAL ${lpad(dollars(t.total), 10)}`, { color: "white", bright: true });
		const p = paid(s.tenders);
		if (p > 0) scr.text(scr.rows - 2, 36, `PAID ${lpad(dollars(p), 9)}   BALANCE DUE ${lpad(dollars(t.total - p), 9)}`, { color: "yellow", bright: true });
		message(scr, s.msg ?? "");
		keys(scr, "PF2=PRICE PF3=SIGN OFF PF4=FUNCTIONS PF5=TENDER PF6=VOID LINE PF12=VOID SALE");
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
					const id = await writeSale(ctx.env.DB, s.lane, s.token, s.lines, [], await taxRate(ctx, s), "X");
					return newSale(s.lane, `${msgId(ctx, "2217I")} SALE ${id} VOIDED`);
				} catch (e) {
					return drawerGone(ctx, s, e);
				}
			}
			case pf(5):
				if (live.length === 0) return fail("item", "2218E RING AN ITEM FIRST");
				return { p: "tender", lane: s.lane, back: s } satisfies TenderState;
			case pf(4):
			case pf(3):
				if (s.lines.length > 0) return fail("item", "2219E FINISH OR VOID THE SALE FIRST");
				if (inp.aid === pf(4)) return { p: "functions", lane: s.lane, back: s } satisfies FunctionsState;
				await laneAudit(ctx.env.DB, s.lane, "REG.SIGNOFF");
				return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2110I")} ${s.lane.name} SIGNED OFF`);
		}
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// A drawer closed under a sale (by a back-office close, say) can't take
// it: the operator signs on again to a new drawer.
function drawerGone(ctx: PosCtx, s: SaleState, e: unknown) {
	if (!(e instanceof DrawerClosed)) throw e;
	return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2220E")} DRAWER ${s.lane.drawer} IS CLOSED - SIGN ON AGAIN`);
}

// POS230 TENDER: payment, in as many parts as the customer likes. Cash can
// be more than is due, for change; a card or check can't. The sale is
// written when nothing is left to pay.

const KINDS: Record<string, TenderKind> = { C: "CASH", CASH: "CASH", D: "CARD", CARD: "CARD", K: "CHECK", CHECK: "CHECK" };

export const tender = onLane(panel<TenderState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS230", "TENDER", s.lane);
		const t = totals(s.back.lines, await taxRate(ctx, s));
		const due = t.total - paid(s.back.tenders);
		const row = (r: number, l: string, v: number, bright = false) => {
			label(scr, r, 4, l);
			scr.text(r, 20, lpad(dollars(v), 10), { color: bright ? "white" : "green", bright });
		};
		row(5, "SUBTOTAL", t.subtotal);
		row(6, "TAX", t.tax);
		row(7, "TOTAL", t.total, true);
		s.back.tenders.forEach((x, i) => {
			scr.text(9 + i, 4, pad(`${i + 1} ${x.kind}${x.ref ? ` ${x.kind === "CARD" ? "****" : "#"}${x.ref}` : ""}`, 24), { color: "turquoise" });
			scr.text(9 + i, 30, lpad(dollars(x.amount), 10), { color: "green" });
		});
		const after = 9 + Math.max(s.back.tenders.length, 1);
		row(after + 1, "BALANCE DUE", due, true);
		const f = after + 3;
		label(scr, f, 2, "METHOD ===>");
		scr.input(f, 14, 5, "method", "", { bright: s.errField === "method" });
		scr.text(f, 21, "C=CASH  D=CARD  K=CHECK", { color: "blue" });
		label(scr, f + 1, 2, "AMOUNT ===>");
		scr.input(f + 1, 14, 9, "amount", dollars(due), { bright: s.errField === "amount" });
		label(scr, f + 2, 2, "REF    ===>");
		scr.input(f + 2, 14, 8, "ref", "", { bright: s.errField === "ref" });
		scr.text(f + 2, 24, "CARD: LAST 4 DIGITS  CHECK: CHECK NUMBER", { color: "blue" });
		label(scr, f + 3, 2, "AUTH   ===>");
		scr.input(f + 3, 14, 10, "auth", "", { bright: s.errField === "auth" });
		scr.text(f + 3, 26, "CARD: THE APPROVAL CODE FROM THE CARD TERMINAL", { color: "blue" });
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
		const rate = await taxRate(ctx, s);
		const due = totals(sale.lines, rate).total - paid(sale.tenders);
		const kind = KINDS[(inp.fields.method ?? "").trim().toUpperCase()];
		if (!kind) return fail("method", "2304E METHOD MUST BE C (CASH), D (CARD) OR K (CHECK)");
		const amtTyped = (inp.fields.amount ?? "").trim();
		const amount = amtTyped ? cents(amtTyped) : due;
		if (!amount) return fail("amount", "2305E KEY THE AMOUNT, E.G. 20.00");
		if (kind !== "CASH" && amount > due) return fail("amount", `2306E A ${kind} CAN PAY AT MOST THE ${dollars(due)} DUE`);
		const ref = (inp.fields.ref ?? "").trim();
		const auth = (inp.fields.auth ?? "").trim().toUpperCase();
		if (kind === "CARD" && !/^\d{4}$/.test(ref)) return fail("ref", "2307E KEY THE CARD'S LAST 4 DIGITS");
		if (kind === "CARD" && !/^[A-Z0-9]{2,10}$/.test(auth)) return fail("auth", "2308E KEY THE APPROVAL CODE FROM THE CARD TERMINAL");
		if (kind === "CHECK" && !/^\d{1,8}$/.test(ref)) return fail("ref", "2309E KEY THE CHECK NUMBER");
		if (sale.tenders.length >= 8) return fail("method", "2310E A SALE TAKES AT MOST 8 TENDERS");
		const x: Tender = { kind, amount: Math.min(amount, due), tendered: amount, ...(kind !== "CASH" ? { ref } : {}), ...(kind === "CARD" ? { auth } : {}) };
		sale.tenders.push(x);
		if (x.amount < due) {
			s.msg = `${msgId(ctx, "2311I")} ${kind} ${dollars(x.amount)} APPLIED - ${dollars(due - x.amount)} STILL DUE`;
			return s;
		}
		try {
			const id = await writeSale(ctx.env.DB, sale.lane, sale.token, sale.lines, sale.tenders, rate, "C");
			const change = amount - x.amount;
			return {
				p: "receipt", lane: sale.lane, sale: id, change, back: newSale(sale.lane),
				msg: `${msgId(ctx, "2312I")} SALE ${id} COMPLETE${change > 0 ? ` - CHANGE DUE ${dollars(change)}` : ""}`,
			} satisfies ReceiptState;
		} catch (e) {
			sale.tenders.pop();
			return drawerGone(ctx, sale, e);
		}
	},
}));
