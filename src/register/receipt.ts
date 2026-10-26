import { clock, invalidKey, keys, label, lpad, message, msgId, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { Invalid } from "../data/db";
import { approves, checkPin } from "../data/pins";
import { getSale, listSales, postVoid, type Sale } from "../data/register";
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
// store-register-sale.
export const receiptNo = (s: Pick<Sale, "store" | "reg" | "id">) => `${s.store}-${two(s.reg)}-${String(s.id).padStart(6, "0")}`;

// receipt lays out a sale as the 40-column receipt printer would.
export function receipt(ctx: PosCtx, st: Store, s: Sale, taxRate: number): string[] {
	const out: string[] = [];
	for (const h of [st.header1, st.header2]) if (h) out.push(center(h));
	out.push(center(st.addr1), center([st.city, st.state, st.zip].filter(Boolean).join(" ")));
	if (st.phone) out.push(center(st.phone));
	out.push("", both(`STORE ${s.store} REG ${two(s.reg)} OPER ${s.operator}`, clock(ctx, s.at)), both("RECEIPT", receiptNo(s)), "-".repeat(WIDTH));
	for (const l of s.lines) {
		out.push(both(pad(l.desc, 30), `${dollars(l.amount)}${l.taxable ? "T" : " "}`));
		if (l.qty !== 1000 || l.weighed) out.push(`  ${showQty(l.qty, l.weighed)} @ ${dollars(l.price)}${l.weighed ? "/LB" : ""}`);
		if (l.void) out.push(both("  LINE VOIDED", `${dollars(-l.amount)} `));
	}
	out.push("-".repeat(WIDTH), both("SUBTOTAL", `${dollars(s.subtotal)} `), both(`TAX ${rate(taxRate)}%`, `${dollars(s.tax)} `), both("TOTAL", `${dollars(s.total)} `), "");
	for (const t of s.tenders) {
		const what = t.kind === "CARD" ? `CARD ****${t.ref} AUTH ${t.auth}` : t.kind === "CHECK" ? `CHECK #${t.ref}` : "CASH";
		out.push(both(what, `${dollars(t.tendered)} `));
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
		const lines = receipt(ctx, st, sale, st.taxRate);
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

// POS290 MANAGER APPROVAL: a supervisor, manager or administrator keys
// their operator ID and PIN to approve what the operator can't do alone.

export const approve = onLane(panel<ApproveState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS290", "MANAGER APPROVAL", s.lane);
		const sale = await getSale(ctx.env.DB, s.sale);
		scr.text(5, 2, "APPROVAL IS NEEDED TO:", { color: "white", bright: true });
		scr.text(6, 4, `VOID SALE ${sale ? receiptNo(sale) : s.sale}, ${dollars(sale?.total ?? 0)}, PAID ${sale ? clock(ctx, sale.at) : ""}`, { color: "yellow", bright: true });
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
		try {
			await postVoid(ctx.env.DB, s.lane, s.sale, { emp: got.op.emp, op: got.op.operator });
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			return { ...s.back, msg: `${msgId(ctx, "2906E")} ${e.message}` };
		}
		return { ...s.back, msg: `${msgId(ctx, "2907I")} SALE ${s.sale} VOIDED - APPROVED BY ${got.op.name}` };
	},
}));
