import { invalidKey, keys, label, lpad, message, msgId, panel, pf, withFill, type Input, type Screen } from "@greenscreen-dev/worker";
import { Invalid, siteNo } from "../data/db";
import { closeDrawer, countTotal, DENOMS, drawerMove, drawerTotals, laneAudit, readCounts, suspend, type Counts } from "../data/register";
import type { Env } from "../env";
import { cents, dollars } from "../money";
import type { PosCtx } from "../screens/types";
import { laneScreen, newSale, onLane, signOn } from "./common";
import { priceSale, localNow } from "./sale";
import type { CloseDrawerState, CustomerState, DisplayState, FunctionsState, GiftState, PaidState, ReceiptsState, ResumeState, ReturnState, SaleState } from "./types";

// countForm draws a denomination count: bills on the left, coins on the
// right, each with what it comes to, and the total.
export function countForm(scr: Screen, top: number, counts: Counts, errField?: string): void {
	DENOMS.forEach((d, i) => {
		const coin = d.cents < 100;
		const row = top + (coin ? i - 6 : i);
		const col = coin ? 42 : 4;
		const n = counts[d.name] ?? 0;
		label(scr, row, col, `${lpad(coin ? d.name : `$${d.name}`, 4)} X`);
		scr.input(row, col + 8, 5, `n:${d.name}`, n ? String(n) : "", { numeric: true, bright: errField === `n:${d.name}` });
		scr.text(row, col + 15, `= ${lpad(dollars(n * d.cents), 9)}`, { color: "green" });
	});
	label(scr, top + 7, 4, "TOTAL COUNTED");
	scr.text(top + 7, 23, lpad(dollars(countTotal(counts)), 10), { color: "white", bright: true });
}

// readCountsInto puts a typed count in s.counts, or the error in s.
export function readCountsInto(ctx: PosCtx, s: { counts: Counts; msg?: string; errField?: string }, inp: Input): boolean {
	try {
		s.counts = readCounts(inp.fields);
		return true;
	} catch (e) {
		if (!(e instanceof Invalid)) throw e;
		s.msg = `${msgId(ctx, "2501E")} ${e.message}`;
		s.errField = e.field;
		withFill(s as never, { fields: inp.fields, cursor: e.field });
		return false;
	}
}

// POS225 REGISTER FUNCTIONS, between sales.

// The first six (and 11) are for between sales; the rest work during one too.
const OPTIONS = [
	["1", "RECEIPTS", "Reprint a receipt, or void a sale (with a manager)"],
	["2", "PAID IN", "Cash put in the drawer, with a reason"],
	["3", "PAID OUT", "Cash taken out of the drawer, with a reason"],
	["4", "NO SALE", "Open the drawer"],
	["5", "CLOSE DRAWER", "Count the drawer out and sign off"],
	["6", "SIGN OFF", "Leave the drawer open for the next operator"],
	["7", "CUSTOMER", "Put a customer on the sale, by phone"],
	["8", "RETURN", "Take items back, from a receipt or without one"],
	["9", "GIFT CARD", "Sell or load a gift card; PF2 there for a balance"],
	["10", "SUSPEND", "Put this sale aside to finish later today"],
	["11", "RESUME", "Finish a sale suspended at this store today"],
	["12", "DISPLAY", "Pair a customer display to this register"],
] as const;

export const functions = onLane(panel<FunctionsState, Env>({
	render(ctx, s) {
		const scr = laneScreen(ctx, "POS225", "REGISTER FUNCTIONS", s.lane);
		label(scr, 5, 2, "OPTION ===>");
		scr.input(5, 14, 2, "option", "", { bright: s.errField === "option" });
		OPTIONS.forEach(([k, name, desc], i) => {
			scr.text(7 + i, 3, lpad(k, 2), { color: "white", bright: true });
			scr.text(7 + i, 7, name, { color: "turquoise" });
			scr.text(7 + i, 21, desc, { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN TO SALE");
		scr.cursorTo("option");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const opt = (inp.fields.option ?? "").trim().toUpperCase();
		const pick = OPTIONS.find(([k, name]) => opt === k || (opt.length > 1 && name.startsWith(opt)));
		const lane = s.lane;
		const busy = s.back.lines.length > 0;
		const between = ["1", "2", "3", "4", "5", "6", "11"];
		if (pick && busy && between.includes(pick[0])) {
			s.msg = `${msgId(ctx, "2253E")} ${pick[1]} IS FOR BETWEEN SALES - FINISH, SUSPEND OR VOID THIS ONE FIRST`;
			s.errField = "option";
			return s;
		}
		switch (pick?.[0]) {
			case "1":
				return { p: "receipts", lane, back: s.back } satisfies ReceiptsState;
			case "2":
			case "3":
				return { p: "paid", lane, back: s.back, kind: pick[0] === "2" ? "PAIDIN" : "PAIDOUT", token: crypto.randomUUID() } satisfies PaidState;
			case "4":
				await drawerMove(ctx.env.DB, lane, crypto.randomUUID(), "NOSALE", 0, "");
				return { ...s.back, msg: `${msgId(ctx, "2251I")} DRAWER OPENED - NO SALE` };
			case "5":
				return { p: "closedrawer", lane, back: s.back, counts: {} } satisfies CloseDrawerState;
			case "6":
				await laneAudit(ctx.env.DB, lane, "REG.SIGNOFF");
				return signOn(lane.store, lane.reg, lane.via, `${msgId(ctx, "2110I")} ${lane.name} SIGNED OFF`);
			case "7":
				return { p: "customer", lane, back: s.back } satisfies CustomerState;
			case "8":
				return { p: "return", lane, back: s.back } satisfies ReturnState;
			case "9":
				return { p: "gift", lane, back: s.back } satisfies GiftState;
			case "10":
				return suspendSale(ctx, s.back);
			case "11":
				return { p: "resume", lane, back: s.back } satisfies ResumeState;
			case "12":
				return { p: "display", lane, back: s.back } satisfies DisplayState;
		}
		s.msg = `${msgId(ctx, "2252E")} ${opt ? `INVALID OPTION ${opt}` : "KEY AN OPTION"}`;
		s.errField = "option";
		return s;
	},
}));

// suspendSale puts the sale aside, as rung, for any register in the store
// to resume today.
async function suspendSale(ctx: PosCtx, sale: SaleState) {
	if (!sale.lines.some((l) => !l.void)) return { ...sale, msg: `${msgId(ctx, "2254E")} NOTHING TO SUSPEND` };
	if (sale.tenders.length > 0) return { ...sale, msg: `${msgId(ctx, "2211E")} PAYMENT HAS STARTED - REMOVE IT FIRST (PF5, THEN PF6)` };
	const t = await priceSale(ctx, sale);
	const { token, lines, coupons, saleDisc, customer } = sale;
	const id = await suspend(ctx.env.DB, sale.lane, localNow(ctx).slice(0, 10), t.items, t.total, { token, lines, coupons, saleDisc, customer });
	return newSale(sale.lane, `${msgId(ctx, "2255I")} SALE SUSPENDED AS NO. ${id} - RESUME IT TODAY AT ANY REGISTER (PF4, 11)`);
}

// POS260 PAID IN / PAID OUT: cash in or out of the drawer that isn't a sale.

export const paid = onLane(panel<PaidState, Env>({
	render(ctx, s) {
		const scr = laneScreen(ctx, "POS260", s.kind === "PAIDIN" ? "PAID IN" : "PAID OUT", s.lane);
		label(scr, 6, 2, "AMOUNT ===>");
		scr.input(6, 14, 9, "amount", "", { bright: s.errField === "amount" });
		label(scr, 7, 2, "REASON ===>");
		scr.input(7, 14, 30, "reason", "", { bright: s.errField === "reason" });
		scr.text(9, 2, s.kind === "PAIDIN" ? "E.G. CHANGE FROM THE SAFE" : "E.G. COFFEE FOR THE BREAK ROOM, A DELIVERY TIP", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=CANCEL  ENTER=RECORD");
		scr.cursorTo(s.errField ?? "amount");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const amount = cents(inp.fields.amount ?? "");
		const reason = (inp.fields.reason ?? "").trim().toUpperCase().slice(0, 30);
		const fail = (field: string, msg: string) => {
			s.msg = `${msgId(ctx, "2601E")} ${msg}`;
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		if (!amount) return fail("amount", "KEY THE AMOUNT, E.G. 20.00");
		if (!reason) return fail("reason", "KEY THE REASON");
		if (s.kind === "PAIDOUT") {
			const t = await drawerTotals(ctx.env.DB, s.lane.drawer!);
			if (amount > t.expected) return fail("amount", `THE DRAWER SHOULD HOLD ONLY ${dollars(t.expected)}`);
		}
		await drawerMove(ctx.env.DB, s.lane, s.token, s.kind, amount, reason);
		return { ...s.back, msg: `${msgId(ctx, "2602I")} ${s.kind === "PAIDIN" ? "PAID IN" : "PAID OUT"} ${dollars(amount)} RECORDED` };
	},
}));

// POS250 CLOSE DRAWER: the drawer counted out, blind: the operator sees
// what it should have held only once the count is in.

export const closedrawer = onLane(panel<CloseDrawerState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS250", "CLOSE DRAWER", s.lane);
		if (s.closed) {
			const t = await drawerTotals(ctx.env.DB, s.lane.drawer!);
			const row = (r: number, l: string, v: number, bright = false) => {
				label(scr, r, 4, l);
				scr.text(r, 24, lpad(dollars(v), 10), { color: bright ? "white" : "green", bright });
			};
			scr.text(5, 2, `DRAWER ${siteNo(s.lane.drawer ?? 0)} CLOSED - ${t.sales} SALE(S)`, { color: "white", bright: true });
			row(7, "OPENING FLOAT", t.opening);
			row(8, "CASH SALES", t.cashSales);
			row(9, "PAID IN", t.paidIn);
			row(10, "PAID OUT", -t.paidOut);
			row(11, "EXPECTED", s.closed.expected, true);
			row(12, "COUNTED", s.closed.counted, true);
			label(scr, 13, 4, s.closed.overShort < 0 ? "SHORT" : "OVER");
			scr.text(13, 24, lpad(dollars(s.closed.overShort), 10), { color: s.closed.overShort === 0 ? "green" : "yellow", bright: true });
			row(15, "CARD", t.card);
			row(16, "CHECK", t.check);
			message(scr, s.msg ?? "");
			keys(scr, "ENTER=SIGN OFF");
			scr.setCursor(scr.rows, 2);
			return scr;
		}
		scr.text(5, 2, "COUNT THE DRAWER OUT: HOW MANY OF EACH BILL AND COIN, FLOAT INCLUDED.", { color: "blue" });
		countForm(scr, 7, s.counts, s.errField);
		message(scr, s.msg ?? "");
		keys(scr, "PF3=CANCEL  PF10=CLOSE DRAWER  ENTER=ADD UP");
		scr.cursorTo(s.errField ?? "n:100");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (s.closed) {
			return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2110I")} ${s.lane.name} SIGNED OFF`);
		}
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER" && inp.aid !== pf(10)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		if (!readCountsInto(ctx, s, inp)) return s;
		if (inp.aid === "ENTER") return s;
		try {
			s.closed = await closeDrawer(ctx.env.DB, s.lane, s.lane.drawer!, s.counts);
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2502W")} ${e.message}`);
		}
		await laneAudit(ctx.env.DB, s.lane, "REG.SIGNOFF");
		const o = s.closed.overShort;
		s.msg = `${msgId(ctx, o === 0 ? "2503I" : "2504W")} DRAWER ${siteNo(s.lane.drawer ?? 0)} CLOSED${o === 0 ? " - IN BALANCE" : o < 0 ? ` - SHORT ${dollars(-o)}` : ` - OVER ${dollars(o)}`}`;
		return s;
	},
}));
