import { clock, invalidKey, keys, label, lpad, message, msgId, panel, pf, withFill } from "@greenscreen-dev/worker";
import { Invalid } from "../data/db";
import { addCustomer, customerByPhone, getCard, giftNumber, phoneDigits, showPhone } from "../data/customers";
import { listSuspended, resume } from "../data/register";
import type { Env } from "../env";
import { cents, dollars } from "../money";
import { laneScreen, newSale, onLane, two } from "./common";
import type { CustomerState, GiftState, ResumeState, SaleState } from "./types";
import { localNow } from "./sale";

// POS234 CUSTOMER: the customer on the sale, found by phone or added on
// the spot. A tax-exempt customer's sale carries no tax.

export const customer = onLane(panel<CustomerState, Env>({
	render(ctx, s) {
		const scr = laneScreen(ctx, "POS234", "CUSTOMER", s.lane);
		label(scr, 5, 2, "PHONE ======>");
		scr.input(5, 16, 14, "phone", s.phone ? showPhone(s.phone) : "", { bright: s.errField === "phone" });
		if (s.adding) {
			scr.text(7, 2, "NOT ON FILE - ADD THE CUSTOMER:", { color: "white", bright: true });
			label(scr, 8, 2, "NAME =======>");
			scr.input(8, 16, 30, "name", "", { bright: s.errField === "name" });
			label(scr, 9, 2, "EMAIL ======>");
			scr.input(9, 16, 40, "email", "", { mixed: true, bright: s.errField === "email" });
			label(scr, 10, 2, "TAX EXEMPT =>");
			scr.input(10, 16, 1, "exempt", "N", { bright: s.errField === "exempt" });
			label(scr, 10, 20, "CERTIFICATE ===>");
			scr.input(10, 37, 20, "exemptId", "", { bright: s.errField === "exemptId" });
		} else if (s.back.customer) {
			const c = s.back.customer;
			scr.text(7, 2, `ON THIS SALE: ${c.name}  ${showPhone(c.phone)}${c.exempt ? "  TAX EXEMPT" : ""}`, { color: "turquoise" });
		}
		message(scr, s.msg ?? "");
		keys(scr, `PF3=RETURN TO SALE  ${s.back.customer ? "PF6=TAKE OFF THE SALE  " : ""}ENTER=${s.adding ? "ADD" : "FIND"}`);
		scr.cursorTo(s.errField ?? (s.adding ? "name" : "phone"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(6) && s.back.customer) {
			const name = s.back.customer.name;
			s.back.customer = undefined;
			return { ...s.back, msg: `${msgId(ctx, "2341I")} ${name} TAKEN OFF THE SALE` };
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
		const phone = phoneDigits(inp.fields.phone ?? "");
		if (!phone) return fail("phone", "2342E KEY THE 10-DIGIT PHONE NUMBER");
		if (phone !== s.phone) s.adding = false;
		s.phone = phone;
		let c = await customerByPhone(ctx.env.DB, phone);
		if (!c && !s.adding) {
			s.adding = true;
			s.msg = `${msgId(ctx, "2343I")} NO CUSTOMER WITH PHONE ${showPhone(phone)} - KEY THEIR NAME TO ADD THEM`;
			return s;
		}
		if (!c) {
			try {
				c = await addCustomer(ctx.env.DB, `OP${s.lane.op}`, phone, {
					name: inp.fields.name ?? "", email: inp.fields.email ?? "", exempt: inp.fields.exempt ?? "", exemptId: inp.fields.exemptId ?? "",
				}, s.lane.store);
			} catch (e) {
				if (!(e instanceof Invalid)) throw e;
				return fail(e.field, `2344E ${e.message}`);
			}
		}
		s.back.customer = { id: c.id, name: c.name, phone: c.phone, exempt: c.exempt };
		return { ...s.back, msg: `${msgId(ctx, "2345I")} CUSTOMER ${c.name}${c.exempt ? " - TAX EXEMPT" : ""}` };
	},
}));

// POS235 GIFT CARD: a gift card sold or loaded, as a line on the sale. PF2
// shows what is on a card.

export const gift = onLane(panel<GiftState, Env>({
	render(ctx, s) {
		const scr = laneScreen(ctx, "POS235", "GIFT CARD", s.lane);
		label(scr, 5, 2, "CARD NUMBER ===>");
		scr.input(5, 19, 19, "card", "", { bright: s.errField === "card" });
		label(scr, 6, 2, "AMOUNT ========>");
		scr.input(6, 19, 9, "amount", "", { bright: s.errField === "amount" });
		scr.text(8, 2, "SCAN THE CARD AND KEY WHAT GOES ON IT, 5.00 TO 500.00. IT IS LOADED WHEN THE", { color: "blue" });
		scr.text(9, 2, "SALE IS PAID FOR.", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, "PF2=BALANCE  PF3=RETURN TO SALE  ENTER=ADD TO SALE");
		scr.cursorTo(s.errField ?? "card");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER" && inp.aid !== pf(2)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const typed = (inp.fields.card ?? "").trim().toUpperCase();
		const number = giftNumber(typed) || (/^SC\d{12}$/.test(typed) ? typed : "");
		if (!number) return fail("card", "2351E SCAN THE CARD, OR KEY ITS 8 TO 19 DIGITS");
		const card = await getCard(ctx.env.DB, number);
		if (inp.aid === pf(2)) {
			if (!card) return fail("card", `2352E CARD ${number} HAS NEVER BEEN LOADED`);
			s.msg = `${msgId(ctx, "2353I")} ${card.kind === "GIFT" ? "GIFT CARD" : "STORE CREDIT"} ${number} HOLDS ${dollars(card.balance)}${card.status === "A" ? "" : " - INACTIVE"}`;
			return s;
		}
		if (card && (card.kind !== "GIFT" || card.status !== "A")) return fail("card", `2354E ${number} ISN'T A GIFT CARD IN USE`);
		const amount = cents(inp.fields.amount ?? "");
		if (!amount || amount < 500 || amount > 50000) return fail("amount", "2355E AMOUNT MUST BE 5.00 TO 500.00");
		if (s.back.lines.some((l) => l.card === number && !l.void)) return fail("card", `2356E CARD ${number} IS ALREADY ON THIS SALE`);
		s.back.lines.push({
			sku: "GIFTCARD", desc: `GIFT CARD *${number.slice(-4)}`, dept: 0, qty: 1000,
			price: amount, amount, taxable: false, weighed: false, card: number,
		});
		return { ...s.back, msg: `${msgId(ctx, "2357I")} GIFT CARD ${number} - ${dollars(amount)} ${card ? "MORE" : "NEW"}` };
	},
}));

// POS236 RESUME: the sales suspended at this store today. S takes one back
// to finish here.

export const resumePanel = onLane(panel<ResumeState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS236", "RESUME A SALE", s.lane);
		const list = await listSuspended(ctx.env.DB, s.lane.store, localNow(ctx).slice(0, 10));
		s.keys = list.map((x) => String(x.id));
		scr.text(5, 2, "SELECT: S=RESUME HERE", { color: "blue" });
		scr.text(6, 2, "S   NO.  REG  OPERATOR  SUSPENDED       ITEMS      TOTAL", { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		if (list.length === 0) scr.text(8, 4, "NO SALES ARE SUSPENDED AT THIS STORE TODAY", { color: "blue" });
		list.slice(0, scr.rows - 10).forEach((x, i) => {
			const row = 8 + i;
			scr.input(row, 2, 1, `sel:${x.id}`, "", { bright: s.errSel === `sel:${x.id}` });
			scr.text(row, 4, lpad(x.id, 5), { color: "turquoise" });
			scr.text(row, 11, two(x.reg), { color: "green" });
			scr.text(row, 16, x.operator.padEnd(8), { color: "green" });
			scr.text(row, 26, clock(ctx, x.at), { color: "green" });
			scr.text(row, 42, lpad(x.items, 5), { color: "green" });
			scr.text(row, 48, lpad(dollars(x.total), 10), { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN TO SALE");
		if (list.length) scr.cursorTo(`sel:${list[0].id}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const key of s.keys ?? []) {
			const code = (inp.fields[`sel:${key}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			if (code !== "S") {
				s.msg = `${msgId(ctx, "2361E")} INVALID SELECTION CODE "${code}" - TYPE S`;
				s.errSel = `sel:${key}`;
				return s;
			}
			const got = (await resume(ctx.env.DB, s.lane, Number(key), localNow(ctx).slice(0, 10))) as Partial<SaleState> | undefined;
			if (!got) {
				s.msg = `${msgId(ctx, "2362E")} SALE ${key} WAS JUST RESUMED ELSEWHERE`;
				return s;
			}
			const sale = newSale(s.lane, `${msgId(ctx, "2363I")} SALE ${key} RESUMED`);
			return { ...sale, lines: got.lines ?? [], coupons: got.coupons ?? [], saleDisc: got.saleDisc, customer: got.customer, token: got.token ?? sale.token };
		}
		return s;
	},
}));
