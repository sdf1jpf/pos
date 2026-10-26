import { clock, invalidKey, keys, label, lpad, message, msgId, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { Invalid } from "../data/db";
import { approves, checkPin } from "../data/pins";
import { pctText } from "../data/pricing";
import { getSale, lineAmount, postVoid } from "../data/register";
import { getStore } from "../data/stores";
import type { Env } from "../env";
import { cents, dollars } from "../money";
import type { PosCtx } from "../screens/types";
import { laneScreen, onLane } from "./common";
import { receiptNo } from "./receipt";
import type { ApproveState, DiscountState, Pending, SaleState } from "./types";

// Why a price was overridden.
export const REASONS: Record<string, string> = {
	PM: "PRICE MATCH",
	AD: "AD PRICE",
	MK: "MISMARKED",
	DM: "DAMAGED",
	MG: "MANAGER'S CALL",
};

// readDiscount reads "10%" (hundredths of a percent) or "2.00" (cents).
function readDiscount(s: string): { pct?: number; amount?: number } | undefined {
	const t = s.trim();
	const m = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%$/.exec(t);
	if (m) {
		const pct = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
		return pct <= 10000 ? { pct } : undefined;
	}
	const c = cents(t);
	return c === undefined ? undefined : { amount: c };
}

// apply makes an approved (or allowed) change to the sale being rung.
function apply(sale: SaleState, p: Pending, approver?: string): void {
	if (p.add) {
		sale.lines.push({ ...p.add, ret: { noReceipt: true, approver: approver ?? "" } });
		return;
	}
	if (p.line === undefined) {
		sale.saleDisc = p.pct ? { pct: p.pct, ...(approver ? { approver } : {}) } : undefined;
		return;
	}
	const l = sale.lines[p.line - 1];
	if (p.price !== undefined) {
		l.override = { from: l.override?.from ?? l.price, reason: p.reason ?? "", approver: approver ?? "" };
		l.price = p.price;
		l.amount = lineAmount(l.qty, p.price);
		return;
	}
	l.disc = p.pct || p.amount ? { ...(p.pct ? { pct: p.pct } : { amount: p.amount }), ...(approver ? { approver } : {}) } : undefined;
}

// POS227 DISCOUNT: a discount off a line or the whole sale, or a line's
// price overridden. Discounts over the store's limit, and every override,
// need a supervisor's or manager's approval.

export const discount = onLane(panel<DiscountState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS227", "DISCOUNT OR PRICE OVERRIDE", s.lane);
		const st = await getStore(ctx.env.DB, s.lane.store);
		label(scr, 5, 2, "LINE ======>");
		scr.input(5, 15, 2, "line", "", { numeric: true, bright: s.errField === "line" });
		scr.text(5, 19, "BLANK FOR THE WHOLE SALE", { color: "blue" });
		label(scr, 6, 2, "DISCOUNT ==>");
		scr.input(6, 15, 7, "disc", "", { bright: s.errField === "disc" });
		scr.text(6, 24, `10% OR 2.00 OFF; 0 TAKES IT OFF. OVER ${st?.discountLimit ?? 0}% NEEDS A MANAGER`, { color: "blue" });
		label(scr, 8, 2, "NEW PRICE =>");
		scr.input(8, 15, 9, "price", "", { bright: s.errField === "price" });
		label(scr, 8, 27, "REASON ===>");
		scr.input(8, 39, 2, "reason", "", { bright: s.errField === "reason" });
		scr.text(8, 43, "A PRICE OVERRIDE NEEDS A MANAGER", { color: "blue" });
		scr.text(9, 4, Object.entries(REASONS).map(([k, v]) => `${k}=${v}`).join("  "), { color: "blue" });
		scr.text(11, 2, "LN SKU            DESCRIPTION                        QTY     PRICE    AMOUNT", { color: "white", bright: true });
		const room = scr.rows - 3 - 12;
		const from = Math.max(s.back.lines.length - room, 0);
		s.back.lines.slice(from).forEach((l, i) => {
			const row = 12 + i;
			const color = l.void ? "yellow" : "green";
			scr.text(row, 2, lpad(from + i + 1, 2), { color: "turquoise" });
			scr.text(row, 5, pad(l.sku, 14), { color });
			scr.text(row, 20, pad(`${l.void ? "VOID " : ""}${l.desc}`, 30), { color });
			scr.text(row, 61, lpad(`${dollars(l.price)}${l.override ? "*" : ""}`, 8), { color });
			const d = l.disc ? (l.disc.pct !== undefined ? `-${pctText(l.disc.pct)}` : `-${dollars(l.disc.amount ?? 0)}`) : "";
			scr.text(row, 70, lpad(l.void ? "VOID" : d || dollars(l.amount), 9), { color: d ? "yellow" : color });
		});
		if (s.back.saleDisc) scr.text(10, 2, `SALE DISCOUNT ${pctText(s.back.saleDisc.pct)} - KEY 0 WITH THE LINE BLANK TO TAKE IT OFF`, { color: "yellow" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN TO SALE  ENTER=APPLY");
		scr.cursorTo(s.errField ?? "line");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const sale = s.back;
		const lineTyped = (inp.fields.line ?? "").trim();
		const discTyped = (inp.fields.disc ?? "").trim();
		const priceTyped = (inp.fields.price ?? "").trim();
		const reason = (inp.fields.reason ?? "").trim().toUpperCase();
		if (!discTyped && !priceTyped) return fail("disc", "2271E KEY A DISCOUNT, OR A NEW PRICE AND REASON");
		if (discTyped && priceTyped) return fail("price", "2272E A DISCOUNT OR A NEW PRICE - ONE AT A TIME");
		const limit = ((await getStore(ctx.env.DB, s.lane.store))?.discountLimit ?? 0) * 100;
		let p: Pending;
		let needs: boolean;
		if (!lineTyped) {
			if (priceTyped) return fail("line", "2273E KEY THE LINE WHOSE PRICE TO OVERRIDE");
			const d = readDiscount(discTyped);
			if (!d || (d.amount !== undefined && d.amount !== 0)) return fail("disc", "2274E A SALE DISCOUNT IS A PERCENT, E.G. 10%");
			const pct = d.pct ?? 0;
			p = { pct, what: pct ? `SALE DISCOUNT ${pctText(pct)}` : "SALE DISCOUNT TAKEN OFF" };
			needs = pct > limit;
		} else {
			const n = Number(lineTyped);
			const l = sale.lines[n - 1];
			if (!l) return fail("line", `2275E THERE IS NO LINE ${lineTyped}`);
			if (l.void) return fail("line", `2276E LINE ${n} IS VOID`);
			if (l.ret || l.card) return fail("line", `2282E LINE ${n} IS ${l.card ? "A GIFT CARD" : "A RETURN"} - IT TAKES NO DISCOUNT`);
			if (priceTyped) {
				const price = cents(priceTyped);
				if (!price) return fail("price", "2277E KEY THE NEW PRICE, E.G. 4.99");
				if (!REASONS[reason]) return fail("reason", `2278E REASON MUST BE ${Object.keys(REASONS).join(", ")}`);
				p = { line: n, price, reason, what: `LINE ${n} ${l.desc} PRICE ${dollars(l.price)} TO ${dollars(price)} (${REASONS[reason]})` };
				needs = true;
			} else {
				const d = readDiscount(discTyped);
				if (!d) return fail("disc", "2279E DISCOUNT MUST BE A PERCENT OR AN AMOUNT, E.G. 10% OR 2.00");
				if (d.amount !== undefined && d.amount > l.amount) return fail("disc", `2280E LINE ${n} COMES TO ONLY ${dollars(l.amount)}`);
				const pct = d.pct ?? (l.amount > 0 ? Math.ceil(((d.amount ?? 0) * 10000) / l.amount) : 0);
				const off = d.pct !== undefined ? pctText(d.pct) : dollars(d.amount ?? 0);
				p = { line: n, ...d, what: d.pct || d.amount ? `LINE ${n} ${l.desc} ${off} OFF` : `LINE ${n} DISCOUNT TAKEN OFF` };
				needs = pct > limit;
			}
		}
		if (needs) return { p: "approve", lane: s.lane, back: s, action: "adjust", pending: p } satisfies ApproveState;
		apply(sale, p);
		return { ...sale, msg: `${msgId(ctx, "2281I")} ${p.what}` };
	},
}));

// POS290 MANAGER APPROVAL: a supervisor, manager or administrator keys
// their operator ID and PIN to approve what the operator can't do alone.

export const approve = onLane(panel<ApproveState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS290", "MANAGER APPROVAL", s.lane);
		scr.text(5, 2, "APPROVAL IS NEEDED TO:", { color: "white", bright: true });
		scr.text(6, 4, (await what(ctx, s)).slice(0, scr.cols - 5), { color: "yellow", bright: true });
		label(scr, 9, 2, "MANAGER OPERATOR ===>");
		scr.input(9, 24, 6, "operator", "", { numeric: true, bright: s.errField === "operator" });
		label(scr, 10, 2, "PIN              ===>");
		scr.input(10, 24, 4, "pin", "", { numeric: true, hidden: true, bright: s.errField === "pin" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=CANCEL  ENTER=APPROVE");
		scr.cursorTo(s.errField ?? "operator");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const operator = (inp.fields.operator ?? "").trim();
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: { operator }, cursor: field });
		};
		if (!operator) return fail("operator", "2901E KEY THE MANAGER'S OPERATOR ID");
		const got = await checkPin(ctx.env.DB, s.lane.store, operator, (inp.fields.pin ?? "").trim(), s.lane.reg);
		if (!got.ok) {
			return got.why === "locked" ? fail("operator", `2902E OPERATOR ${operator} IS LOCKED OUT`)
				: got.why === "store" ? fail("operator", `2903E OPERATOR ${operator} MAY NOT APPROVE IN STORE ${s.lane.store}`)
				: fail("pin", `2904E OPERATOR ID OR PIN IS WRONG${got.left ? ` - ${got.left} ${got.left === 1 ? "TRY" : "TRIES"} LEFT` : ""}`);
		}
		if (!approves(got.op.role)) return fail("operator", `2905E ${got.op.name} MAY NOT APPROVE THIS - A SUPERVISOR OR MANAGER MUST`);
		if (s.action === "adjust") {
			const sale = s.back.back;
			apply(sale, s.pending, `OP${got.op.operator}`);
			return { ...sale, msg: `${msgId(ctx, "2908I")} ${s.pending.what} - APPROVED BY ${got.op.name}`.slice(0, 79) };
		}
		try {
			await postVoid(ctx.env.DB, s.lane, s.sale, { emp: got.op.emp, op: got.op.operator });
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			return { ...s.back, msg: `${msgId(ctx, "2906E")} ${e.message}` };
		}
		return { ...s.back, msg: `${msgId(ctx, "2907I")} SALE ${s.sale} VOIDED - APPROVED BY ${got.op.name}` };
	},
}));

async function what(ctx: PosCtx, s: ApproveState): Promise<string> {
	if (s.action === "adjust") return s.pending.what;
	const sale = await getSale(ctx.env.DB, s.sale);
	return `VOID SALE ${sale ? receiptNo(sale) : s.sale}, ${dollars(sale?.total ?? 0)}, PAID ${sale ? clock(ctx, sale.at) : ""}`;
}
