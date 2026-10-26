import { clock, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import {
	addCustomer, adjustCard, cardMoves, cardNumber, cardRecord, customerCards, customerRecord, customerSales, getCustomer, listCustomers,
	phoneDigits, setCardStatus, showPhone, updateCustomer,
} from "../data/customers";
import { Invalid } from "../data/db";
import { reasonNote, reasons } from "../data/reasons";
import type { Env } from "../env";
import { cents, dollars } from "../money";
import { FIRST, form, guarded, listRows, pick, refused, rowCount, rule, scroll, selected } from "./common";
import type { CardState, CustomersState, CustomerState } from "./types";

// Customers, gift cards and store credit: menu 7. Maps are POS710 to POS720.

const SALE = { C: "", V: "VOIDED", X: "CANCELLED" } as Record<string, string>;

// POS710 CUSTOMERS: found by a word in the name or part of the phone
// number. S shows one; PF5 adds one.

export const customers = guarded("customers", panel<CustomersState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS710");
		header(scr, ctx, "CUSTOMERS");
		label(scr, 3, 2, "SEARCH ===>");
		scr.input(3, 14, 20, "q", s.q ?? "");
		scr.text(3, 36, "A NAME, OR PART OF A PHONE NUMBER", { color: "blue" });
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE", { color: "blue" });
		const { customers, total } = await listCustomers(ctx.env.DB, s.q ?? "", s.top ?? 0, listRows(ctx));
		s.keys = customers.map((c) => String(c.id));
		s.total = total;
		rowCount(scr, s.top ?? 0, customers.length, total);
		scr.text(6, 2, "S     ID  NAME                           PHONE         EMAIL               EX S", { color: "white", bright: true });
		rule(scr, 7);
		if (total === 0) scr.text(FIRST, 4, s.q ? "NO CUSTOMER MATCHES" : "NO CUSTOMERS YET - PF5 TO ADD ONE", { color: "blue" });
		customers.forEach((c, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${c.id}`, "", { bright: s.errSel === `sel:${c.id}` });
			scr.text(row, 4, lpad(c.id, 6), { color: "turquoise" });
			scr.text(row, 12, pad(c.name, 30), { color: "green" });
			scr.text(row, 43, showPhone(c.phone), { color: "green" });
			scr.text(row, 57, pad(c.email, 19), { color: "green" });
			scr.text(row, 77, c.exempt ? "Y" : "N", { color: "green" });
			scr.text(row, 80, c.status, { color: c.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errSel ?? (customers.length ? `sel:${customers[0].id}` : "q"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "custfile", back: s } satisfies CustomerState;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const q = (inp.fields.q ?? "").trim().toUpperCase();
		if (q !== (s.q ?? "")) {
			s.q = q;
			s.top = 0;
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "custfile", back: s, id: Number(x.key) } satisfies CustomerState;
			s.msg = `${msgId(ctx, "7101E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS711 CUSTOMER: add or update, with the cards they hold and their last
// few sales.

const FIELDS = ["name", "phone", "email", "exempt", "exemptId", "status"] as const;

export const customer = guarded("customers", panel<CustomerState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS711");
		const c = s.id !== undefined ? await customerRecord(ctx.env.DB, s.id) : undefined;
		header(scr, ctx, c ? `CUSTOMER ${c.id}` : "ADD CUSTOMER");
		if (s.id !== undefined && !c) {
			message(scr, `${msgId(ctx, "7111E")} CUSTOMER ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (c) s.version ??= c.version;
		form(scr, [
			{ row: 3, label: "NAME", name: "name", len: 30, value: c?.name ?? "" },
			{ row: 4, label: "PHONE", name: "phone", len: 14, value: c ? showPhone(c.phone) : "", note: "TEN DIGITS - HOW THE REGISTER FINDS THEM" },
			{ row: 5, label: "EMAIL", name: "email", len: 40, value: c?.email ?? "" },
			{ row: 6, label: "TAX EXEMPT", name: "exempt", len: 1, value: c ? (c.exempt ? "Y" : "N") : "N" },
			{ row: 6, label: "CERTIFICATE", name: "exemptId", len: 20, value: c?.exemptId ?? "", col: 40 },
			{ row: 7, label: "STATUS", name: "status", len: 1, value: c?.status ?? "A", note: "A=ACTIVE  I=INACTIVE (THE REGISTER WON'T FIND THEM)" },
		], s.errField);
		if (c) {
			const cards = await customerCards(ctx.env.DB, c.id);
			scr.text(9, 2, "CARDS", { color: "white", bright: true });
			if (cards.length === 0) scr.text(10, 4, "NONE", { color: "blue" });
			cards.slice(0, 3).forEach((k, i) => {
				scr.text(10 + i, 4, `${pad(k.number, 20)} ${pad(k.kind === "GIFT" ? "GIFT CARD" : "STORE CREDIT", 13)}${lpad(dollars(k.balance), 10)}  ${k.status === "A" ? "" : "STOPPED"}`, { color: "green" });
			});
			const sales = await customerSales(ctx.env.DB, c.id, 6);
			scr.text(14, 2, "RECENT SALES", { color: "white", bright: true });
			if (sales.length === 0) scr.text(15, 4, "NONE", { color: "blue" });
			sales.forEach((x, i) => {
				scr.text(15 + i, 4, `${clock(ctx, x.at)}  STORE ${x.store} REG ${String(x.reg).padStart(2, "0")}  SALE ${lpad(x.id, 7)}${lpad(dollars(x.total), 11)}  ${SALE[x.status] ?? x.status}`, { color: "green" });
			});
			scr.text(ctx.rows - 2, 2, `LAST CHANGED ${clock(ctx, c.updatedAt)} BY ${c.updatedBy}   VERSION ${c.version}`, { color: "blue" });
		}
		message(scr, s.msg ?? "");
		keys(scr, `PF3=RETURN  ENTER=${c ? "UPDATE" : "ADD"}`);
		scr.cursorTo(s.errField ?? "name");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed = pick(inp, FIELDS);
		try {
			if (s.id !== undefined) {
				const c = await updateCustomer(ctx.env.DB, ctx.user, s.id, s.version ?? 0, typed);
				s.version = c.version;
				s.msg = `${msgId(ctx, "7112I")} CUSTOMER ${c.id} UPDATED`;
			} else {
				const phone = phoneDigits(typed.phone);
				if (!phone) throw new Invalid("phone", "PHONE IS 10 DIGITS, E.G. 555-123-4567");
				const c = await addCustomer(ctx.env.DB, ctx.user, phone, typed);
				s.id = c.id;
				s.version = (await customerRecord(ctx.env.DB, c.id))?.version;
				s.msg = `${msgId(ctx, "7113I")} CUSTOMER ${c.id} ADDED`;
			}
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "7114");
		}
	},
}));

// POS720 GIFT CARDS AND STORE CREDIT: a card's balance and history. A
// balance is changed with a reason code; PF11 stops a card (lost or
// stolen) or lets it be spent again.

export const card = guarded("customers", panel<CardState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS720");
		header(scr, ctx, "GIFT CARDS AND STORE CREDIT");
		label(scr, 3, 2, "CARD NUMBER ===>");
		scr.input(3, 19, 19, "card", s.number ?? "", { bright: s.errField === "card" });
		const k = s.number ? await cardRecord(ctx.env.DB, s.number) : undefined;
		if (!k) {
			scr.text(5, 4, "SCAN OR KEY A GIFT CARD, OR A STORE CREDIT NUMBER (SC...)", { color: "blue" });
			message(scr, s.msg ?? "");
			keys(scr, "PF3=EXIT  ENTER=SHOW");
			scr.cursorTo("card");
			return scr;
		}
		const who = k.customer ? await getCustomer(ctx.env.DB, k.customer) : undefined;
		scr.text(5, 2, `${k.kind === "GIFT" ? "GIFT CARD" : "STORE CREDIT"}   BALANCE ${dollars(k.balance)}`, { color: "white", bright: true });
		scr.text(5, 44, k.status === "A" ? "ACTIVE" : "STOPPED - CAN'T BE SPENT", { color: k.status === "A" ? "green" : "yellow", bright: true });
		scr.text(6, 2, `ISSUED ${clock(ctx, k.issuedAt)}${who ? `   CUSTOMER ${who.id} ${who.name}` : ""}`, { color: "turquoise" });
		label(scr, 8, 2, "ADJUST ===>");
		scr.input(8, 14, 10, "amount", "", { bright: s.errField === "amount" });
		label(scr, 8, 26, "REASON ===>");
		scr.input(8, 38, 2, "reason", "", { bright: s.errField === "reason" });
		scr.text(8, 42, reasonNote(await reasons(ctx.env.DB, "CARD")).slice(0, scr.cols - 43), { color: "blue" });
		scr.text(9, 4, "AN AMOUNT TO ADD, OR -AMOUNT TO TAKE OFF", { color: "blue" });
		scr.text(11, 2, "WHEN            SALE      AMOUNT  BY        REASON", { color: "white", bright: true });
		rule(scr, 12);
		const moves = await cardMoves(ctx.env.DB, k.number, ctx.rows - 3 - 13 + 1);
		if (moves.length === 0) scr.text(13, 4, "NO ACTIVITY", { color: "blue" });
		moves.forEach((m, i) => {
			scr.text(13 + i, 2, `${clock(ctx, m.at)}  ${lpad(m.sale ?? "", 7)}${lpad(dollars(m.amount), 12)}  ${pad(m.userid ?? "", 8)}  ${m.reason}`, { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, `PF3=EXIT  ENTER=SHOW/ADJUST  PF11=${k.status === "A" ? "STOP CARD" : "START CARD"}`);
		scr.cursorTo(s.errField ?? "amount");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER" && inp.aid !== pf(11)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, m: string) => {
			s.msg = msgId(ctx, m);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const number = cardNumber(inp.fields.card ?? "");
		if (!number) return fail("card", "7201E A CARD NUMBER IS 8 TO 19 DIGITS, OR SC AND 12 DIGITS");
		const k = await cardRecord(ctx.env.DB, number);
		if (!k) return fail("card", `7202E CARD ${number} NOT FOUND`);
		if (number !== s.number) {
			s.number = number;
			return s;
		}
		if (inp.aid === pf(11)) {
			const status = k.status === "A" ? "I" : "A";
			await setCardStatus(ctx.env.DB, ctx.user, number, status);
			s.msg = `${msgId(ctx, "7203I")} CARD ${number} ${status === "I" ? "STOPPED" : "STARTED AGAIN"}`;
			return s;
		}
		const typed = (inp.fields.amount ?? "").trim();
		if (!typed) return s;
		const neg = typed.startsWith("-");
		const amt = cents(neg ? typed.slice(1) : typed);
		if (amt === undefined) return fail("amount", "7204E KEY AN AMOUNT, E.G. 5.00 OR -5.00");
		try {
			const after = await adjustCard(ctx.env.DB, ctx.user, number, neg ? -amt : amt, (inp.fields.reason ?? "").trim().toUpperCase());
			s.msg = `${msgId(ctx, "7205I")} CARD ${number} BALANCE NOW ${dollars(after.balance)}`;
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "7206");
		}
	},
}));
