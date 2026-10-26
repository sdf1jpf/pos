import { clock, invalidKey, keys, lpad, message, msgId, pad, panel, pf } from "@greenscreen-dev/worker";
import { siteNo, SPAN } from "../data/db";
import { getCard, getCustomer, type Customer } from "../data/customers";
import { lineAdj, wholeAdj } from "../data/pricing";
import { getSale, listSales, type Sale } from "../data/register";
import { getStore, type Store } from "../data/stores";
import type { Env } from "../env";
import { dollars, rate } from "../money";
import type { PosCtx } from "../screens/types";
import { laneScreen, onLane, showQty, two } from "./common";
import type { ApproveState, ReceiptsState, ReceiptState } from "./types";

const WIDTH = 40;

const center = (s: string) => pad(" ".repeat(Math.max(Math.floor((WIDTH - s.length) / 2), 0)) + s, WIDTH);
const both = (l: string, r: string) => pad(l, WIDTH - r.length - 1) + " " + r;

// receiptNo is what the receipt says and its barcode holds:
// store-register-sale. A sale rung on a store server (its id from the
// store's own range) is marked L: 1-01-L000123.
export const receiptNo = (s: Pick<Sale, "store" | "reg" | "id">) =>
	`${s.store}-${two(s.reg)}-${s.id > SPAN ? "L" : ""}${String(s.id % SPAN).padStart(6, "0")}`;

// saleNo is a sale's number in messages: L123 for one rung on a store server.
export const saleNo = siteNo;

// receipt lays out a sale as the 40-column receipt printer would.
// cards holds the balances of the gift cards and store credit on it.
export function receipt(ctx: PosCtx, st: Store, s: Sale, taxRate: number, cards?: Map<string, number>, customer?: Customer): string[] {
	const out: string[] = [];
	for (const h of [st.header1, st.header2]) if (h) out.push(center(h));
	out.push(center(st.addr1), center([st.city, st.state, st.zip].filter(Boolean).join(" ")));
	if (st.phone) out.push(center(st.phone));
	out.push("", both(`STORE ${s.store} REG ${two(s.reg)} OPER ${s.operator}`, clock(ctx, s.at)), both("RECEIPT", receiptNo(s)));
	if (customer) out.push(pad(`CUSTOMER ${customer.name}`, WIDTH), ...(customer.exempt ? [pad(`TAX EXEMPT ${customer.exemptId}`, WIDTH)] : []));
	out.push("-".repeat(WIDTH));
	s.lines.forEach((l, i) => {
		out.push(both(pad(l.desc, 30), `${dollars(l.amount)}${l.taxable ? "T" : " "}`));
		if (l.ret) out.push(pad(`  RETURN${"sale" in l.ret ? ` FROM ${l.ret.sale} LINE ${l.ret.line}` : ", NO RECEIPT"}`, WIDTH));
		if (l.qty !== 1000 || l.weighed) out.push(`  ${showQty(l.qty, l.weighed)} @ ${dollars(l.price)}${l.weighed ? "/LB" : ""}`);
		if (l.override) out.push(pad(`  PRICE OVERRIDE, WAS ${dollars(l.override.from)} ${l.override.reason}`, WIDTH));
		if (l.void) out.push(both("  LINE VOIDED", `${dollars(-l.amount)} `));
		for (const a of lineAdj(s.adjustments, i + 1)) out.push(both(pad(`  ${a.desc}${a.kind === "LINEDISC" && a.code ? ` ${a.code}` : ""}`, 30), `${dollars(-a.amount)} `));
	});
	out.push("-".repeat(WIDTH), both("SUBTOTAL", `${dollars(s.subtotal)} `));
	for (const a of wholeAdj(s.adjustments)) out.push(both(pad(a.kind === "COUPON" ? `COUPON ${a.code}` : `${a.desc} ${a.code}`, 30), `${dollars(-a.amount)} `));
	out.push(both(`TAX ${rate(taxRate)}%`, `${dollars(s.tax)} `), both("TOTAL", `${dollars(s.total)} `));
	if (s.discount > 0) out.push(center(`YOU SAVED ${dollars(s.discount)}`));
	out.push("");
	for (const t of s.tenders) {
		const what = t.kind === "CARD" ? `CARD ****${t.ref} AUTH ${t.auth}` : t.kind === "CHECK" ? `CHECK #${t.ref}`
			: t.kind === "GIFT" ? `GIFT CARD *${t.ref?.slice(-4)}` : t.kind === "CREDIT" ? `STORE CREDIT ${t.ref}` : "CASH";
		out.push(both(`${t.amount < 0 ? "REFUND " : ""}${what}`, `${dollars(Math.abs(t.tendered))} `));
		const left = cards?.get(t.ref ?? "");
		if (left !== undefined && (t.kind === "GIFT" || t.kind === "CREDIT")) out.push(both("  BALANCE NOW", `${dollars(left)} `));
	}
	for (const l of s.lines) {
		const left = l.card && !l.void ? cards?.get(l.card) : undefined;
		if (left !== undefined) out.push(both(`GIFT CARD *${l.card!.slice(-4)} BALANCE`, `${dollars(left)} `));
	}
	if (s.change > 0) out.push(both("CHANGE", `${dollars(s.change)} `));
	out.push("");
	for (const f of [st.footer1, st.footer2]) if (f) out.push(center(f));
	out.push(center(`*${receiptNo(s)}*`));
	if (s.status === "V") out.push("", center(`*** VOIDED ${clock(ctx, s.voidedAt ?? "")} ***`));
	if (s.status === "X") out.push("", center("*** SALE CANCELLED ***"));
	return out;
}

// POS240 RECEIPT: a sale's receipt, just paid for or recalled.

export const receiptPanel = onLane(panel<ReceiptState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS240", "RECEIPT", s.lane);
		const sale = await getSale(ctx.env.DB, s.sale);
		const st = sale && (await getStore(ctx.env.DB, sale.store));
		if (!sale || !st || sale.store !== s.lane.store) {
			message(scr, `${msgId(ctx, "2401E")} SALE ${s.sale} NOT FOUND`);
			keys(scr, "ENTER=RETURN");
			return scr;
		}
		const numbers = [...sale.tenders.map((t) => t.ref ?? ""), ...sale.lines.map((l) => l.card ?? "")].filter((n) => /^(SC)?\d{8,19}$/.test(n));
		const cards = new Map<string, number>();
		for (const n of new Set(numbers)) {
			const c = await getCard(ctx.env.DB, n);
			if (c) cards.set(n, c.balance);
		}
		const cust = sale.customer ? await getCustomer(ctx.env.DB, sale.customer) : undefined;
		const lines = receipt(ctx, st, sale, st.taxRate, cards, cust);
		const room = scr.rows - 7;
		const top = Math.min(s.top ?? 0, Math.max(lines.length - room, 0));
		s.top = top;
		lines.slice(top, top + room).forEach((l, i) => scr.text(5 + i, 20, l, { color: "white" }));
		if (lines.length > room) scr.text(4, scr.cols - 20, `LINE ${top + 1} OF ${lines.length}`.padStart(18), { color: "white" });
		if (s.change) scr.text(5, 2, `CHANGE DUE`, { color: "yellow", bright: true });
		if (s.change) scr.text(6, 2, lpad(dollars(s.change), 10), { color: "yellow", bright: true });
		message(scr, s.msg ?? "");
		keys(scr, `ENTER=${s.back.p === "sale" ? "NEXT SALE" : "RETURN"}  PF7=UP  PF8=DOWN`);
		scr.setCursor(scr.rows, 2);
		return scr;
	},
	handle(ctx, s, inp) {
		s.msg = undefined;
		if (inp.aid === pf(7) || inp.aid === pf(8)) {
			s.top = Math.max((s.top ?? 0) + (inp.aid === pf(7) ? -(ctx.rows - 7) : ctx.rows - 7), 0);
			return s;
		}
		if (inp.aid === "ENTER" || inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// POS241 RECEIPTS: the register's sales, newest first. S shows one to
// reprint; V voids a paid sale, with a supervisor's or manager's approval.

export const receipts = onLane(panel<ReceiptsState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS241", "RECEIPTS", s.lane);
		scr.text(5, 2, "SELECT: S=SHOW/REPRINT  V=VOID (NEEDS A MANAGER)", { color: "blue" });
		const rows = ctx.rows - 10;
		const { sales, total } = await listSales(ctx.env.DB, s.lane.store, s.lane.reg, s.top ?? 0, rows);
		s.keys = sales.map((x) => String(x.id));
		s.total = total;
		scr.text(6, 2, "S RECEIPT         TIME            OPERATOR      TOTAL  STATUS", { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		if (total === 0) scr.text(8, 4, "NO SALES AT THIS REGISTER YET", { color: "blue" });
		sales.forEach((x, i) => {
			const row = 8 + i;
			scr.input(row, 2, 1, `sel:${x.id}`, "", { bright: s.errSel === `sel:${x.id}` });
			scr.text(row, 4, receiptNo({ ...s.lane, id: x.id }), { color: "turquoise" });
			scr.text(row, 20, clock(ctx, x.at), { color: "green" });
			scr.text(row, 36, pad(x.operator, 8), { color: "green" });
			scr.text(row, 46, lpad(dollars(x.total), 9), { color: "green" });
			scr.text(row, 57, { C: "PAID", X: "CANCELLED", V: "VOIDED" }[x.status], { color: x.status === "C" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF7=UP  PF8=DOWN");
		if (sales.length) scr.cursorTo(`sel:${sales[0].id}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		const rows = ctx.rows - 10;
		if (inp.aid === pf(7)) {
			s.top = Math.max((s.top ?? 0) - rows, 0);
			return s;
		}
		if (inp.aid === pf(8)) {
			if ((s.top ?? 0) + rows < (s.total ?? 0)) s.top = (s.top ?? 0) + rows;
			return s;
		}
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const key of s.keys ?? []) {
			const code = (inp.fields[`sel:${key}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			if (code === "S") return { p: "receipt", lane: s.lane, sale: Number(key), back: s } satisfies ReceiptState;
			if (code === "V") return { p: "approve", lane: s.lane, back: s, action: "postvoid", sale: Number(key) } satisfies ApproveState;
			s.msg = `${msgId(ctx, "2411E")} INVALID SELECTION CODE "${code}" - TYPE S OR V`;
			s.errSel = `sel:${key}`;
			return s;
		}
		return s;
	},
}));
