import { clock, invalidKey, keys, label, lpad, message, msgId, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { findItem, getSale, lineAmount, type Line } from "../data/register";
import type { Env } from "../env";
import { dollars } from "../money";
import { laneScreen, onLane, readQty, showQty } from "./common";
import { receiptNo } from "./receipt";
import type { ApproveState, ReturnState, SaleState } from "./types";

// readReceipt reads a receipt number as printed (1-01-000123), its barcode
// (*1-01-000123*) or a bare sale number, and returns the sale number.
export function readReceipt(s: string): number | undefined {
	const t = s.trim().replace(/^\*|\*$/g, "");
	const m = /^(?:\d{1,3}-\d{1,2}-)?(\d{1,9})$/.exec(t);
	return m ? Number(m[1]) : undefined;
}

// pendingBack is how much of a sold line this sale is already returning.
const pendingBack = (sale: SaleState, id: number, line: number) =>
	sale.lines.filter((l) => !l.void && l.ret && "sale" in l.ret && l.ret.sale === id && l.ret.line === line).reduce((t, l) => t - l.qty, 0);

// POS232 RETURN: a receipt recalled and the lines coming back picked from
// it, refunded at what was paid for them. PF5 takes an item back without a
// receipt: a supervisor or manager approves it, and it is refunded as
// store credit.

export const returnPanel = onLane(panel<ReturnState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS232", s.noReceipt ? "RETURN WITHOUT A RECEIPT" : "RETURN", s.lane);
		if (s.noReceipt) {
			label(scr, 5, 2, "ITEM ===>");
			scr.input(5, 12, 14, "item", "", { bright: s.errField === "item" });
			label(scr, 5, 28, "QTY ===>");
			scr.input(5, 37, 8, "qty", "", { bright: s.errField === "qty" });
			scr.text(7, 2, "REFUNDED AT TODAY'S PRICE, AS STORE CREDIT, WITH A SUPERVISOR'S OR MANAGER'S", { color: "blue" });
			scr.text(8, 2, "APPROVAL.", { color: "blue" });
			message(scr, s.msg ?? "");
			keys(scr, "PF3=RETURN TO SALE  PF5=WITH A RECEIPT  ENTER=RETURN IT");
			scr.cursorTo(s.errField ?? "item");
			return scr;
		}
		label(scr, 5, 2, "RECEIPT ===>");
		scr.input(5, 15, 16, "receipt", s.sale ? receiptNo({ ...(await getSale(ctx.env.DB, s.sale))!, id: s.sale }) : "", { bright: s.errField === "receipt" });
		scr.text(5, 33, "SCAN THE BARCODE OR KEY THE RECEIPT NUMBER", { color: "blue" });
		const sale = s.sale ? await getSale(ctx.env.DB, s.sale) : undefined;
		if (sale) {
			scr.text(6, 2, `SOLD ${clock(ctx, sale.at)} AT STORE ${sale.store} REG ${sale.reg} BY ${sale.operator}, TOTAL ${dollars(sale.total)}`, { color: "turquoise" });
			scr.text(8, 2, "QTY BACK  LN SKU            DESCRIPTION                     SOLD  BACK   REFUND", { color: "white", bright: true });
			scr.text(9, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			let row = 10;
			sale.lines.forEach((l, i) => {
				if (row > scr.rows - 3 || l.void || l.ret || l.card || l.qty <= 0) return;
				const back = l.returned + pendingBack(s.back, sale.id, i + 1);
				scr.input(row, 2, 7, `rq:${i + 1}`, "", { bright: s.errSel === `rq:${i + 1}` });
				scr.text(row, 12, lpad(i + 1, 2), { color: "turquoise" });
				scr.text(row, 15, pad(l.sku, 14), { color: "green" });
				scr.text(row, 30, pad(l.desc, 30), { color: "green" });
				scr.text(row, 61, lpad(showQty(l.qty, l.weighed).replace(" LB", ""), 6), { color: "green" });
				scr.text(row, 68, lpad(back ? showQty(back, l.weighed).replace(" LB", "") : "", 5), { color: "yellow" });
				scr.text(row, 74, lpad(dollars(l.net), 7), { color: "green" });
				row++;
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN TO SALE  PF5=NO RECEIPT  ENTER=RECALL OR RETURN");
		scr.cursorTo(s.errField ?? s.errSel ?? (sale ? "rq:1" : "receipt"));
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = s.errSel = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) {
			s.noReceipt = !s.noReceipt;
			s.sale = undefined;
			return s;
		}
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, msg: string, sel = false) => {
			s.msg = msgId(ctx, msg);
			if (sel) s.errSel = field;
			else s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		if (s.noReceipt) {
			const code = (inp.fields.item ?? "").trim().toUpperCase();
			if (!code) return fail("item", "2321E KEY OR SCAN THE ITEM COMING BACK");
			const it = await findItem(ctx.env.DB, s.lane.store, code);
			if (!it || it === "discontinued") return fail("item", `2322E ITEM ${code} ${it ? "IS DISCONTINUED" : "NOT FOUND"}`);
			const qty = readQty(inp.fields.qty ?? "", it.weighed);
			if (qty === undefined) return fail("qty", it.weighed ? "2323E KEY THE POUNDS, E.G. 1.25" : "2324E QTY MUST BE 1 TO 999");
			const line: Line = {
				sku: it.sku, desc: it.desc, dept: it.dept, qty: -qty, price: it.price, amount: -lineAmount(qty, it.price),
				taxable: it.taxable && !s.back.customer?.exempt, weighed: it.weighed,
			};
			return {
				p: "approve", lane: s.lane, back: s, action: "adjust",
				pending: { add: line, what: `RETURN ${showQty(qty, it.weighed)} ${it.desc} WITHOUT A RECEIPT, ${dollars(-line.amount)} AS STORE CREDIT` },
			} satisfies ApproveState;
		}
		const typed = inp.fields.receipt ?? "";
		const id = readReceipt(typed);
		if (id === undefined) return fail("receipt", "2325E RECEIPT NUMBER LOOKS LIKE 1-01-000123");
		if (id !== s.sale) {
			const sale = await getSale(ctx.env.DB, id);
			if (!sale) return fail("receipt", `2326E RECEIPT ${typed.trim()} NOT FOUND`);
			if (sale.status !== "C") return fail("receipt", `2327E SALE ${id} WAS ${sale.status === "V" ? "VOIDED" : "CANCELLED"} - NOTHING TO RETURN`);
			s.sale = id;
			s.msg = `${msgId(ctx, "2328I")} KEY THE QUANTITY COMING BACK BESIDE EACH LINE`;
			return s;
		}
		const sale = (await getSale(ctx.env.DB, s.sale))!;
		const adds: Line[] = [];
		for (const [i, l] of sale.lines.entries()) {
			const typed = (inp.fields[`rq:${i + 1}`] ?? "").trim();
			if (!typed) continue;
			if (l.void || l.ret || l.card || l.qty <= 0) continue;
			const qty = readQty(typed, l.weighed);
			if (qty === undefined) return fail(`rq:${i + 1}`, l.weighed ? "2323E KEY THE POUNDS, E.G. 1.25" : "2324E QTY MUST BE 1 TO 999", true);
			const left = l.qty - l.returned - pendingBack(s.back, sale.id, i + 1);
			if (qty > left) return fail(`rq:${i + 1}`, `2329E ONLY ${showQty(Math.max(left, 0), l.weighed)} OF LINE ${i + 1} CAN COME BACK`, true);
			// Refunded at what was paid, discounts and all, in proportion.
			const refund = Math.round((l.net * qty) / l.qty);
			adds.push({
				sku: l.sku, desc: l.desc, dept: l.dept, qty: -qty, price: l.price, amount: -refund,
				taxable: l.taxable && sale.tax !== 0 && !s.back.customer?.exempt, weighed: l.weighed, ret: { sale: sale.id, line: i + 1 },
			});
		}
		if (adds.length === 0) return fail("rq:1", "2330E KEY THE QUANTITY COMING BACK BESIDE A LINE", true);
		if (s.back.lines.length + adds.length > 60) return fail("rq:1", "2331E A SALE HOLDS AT MOST 60 LINES", true);
		s.back.lines.push(...adds);
		return { ...s.back, msg: `${msgId(ctx, "2332I")} ${adds.length} LINE(S) RETURNED FROM RECEIPT ${receiptNo(sale)}` };
	},
}));
