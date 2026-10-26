// POS237 ITEM LOOKUP: from the sale, PF11 finds an item by a word in its
// description, the start of its SKU, or its UPC, with the store's price and
// on hand. S beside one rings one of it; an item sold by weight goes back to
// the sale for the pounds.

import { invalidKey, keys, label, lpad, message, msgId, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { findItem, lookupItems } from "../data/register";
import { showQty } from "../data/stock";
import type { Env } from "../env";
import { dollars } from "../money";
import { onLane, laneScreen } from "./common";
import { ring } from "./sale";
import type { LookupState } from "./types";

const FIRST = 8;
const room = (rows: number) => rows - 3 - FIRST; // above the totals line and message

export const lookup = onLane(panel<LookupState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS237", "ITEM LOOKUP", s.lane);
		const n = room(scr.rows);
		const { items, total } = await lookupItems(ctx.env.DB, s.lane.store, s.q, s.top ?? 0, n);
		s.total = total;
		s.keys = items.map((x) => x.sku);
		label(scr, 4, 2, "SEARCH ===>");
		scr.input(4, 14, 30, "q", s.q);
		scr.text(5, 2, "A WORD FROM THE DESCRIPTION, THE START OF A SKU, OR A UPC. SELECT: S=RING ONE", { color: "blue" });
		scr.text(6, 2, "S SKU            DESCRIPTION                          PRICE      ON HAND", { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		if (items.length === 0) scr.text(FIRST, 4, s.q ? `NOTHING ON SALE MATCHES ${s.q}` : "NO ITEMS ARE ON SALE", { color: "blue" });
		items.forEach((x, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${x.sku}`, "", { bright: s.errSel === `sel:${x.sku}` });
			scr.text(row, 4, pad(x.sku, 14), { color: "turquoise" });
			scr.text(row, 19, pad(x.desc, 30), { color: "green" });
			scr.text(row, 50, lpad(`${dollars(x.price)}${x.weighed ? "/LB" : ""}`, 11), { color: "green" });
			scr.text(row, 62, lpad(`${showQty(x.onHand, x.weighed)}${x.weighed ? " LB" : ""}`, 12), { color: x.onHand <= 0 ? "yellow" : "green" });
		});
		if (total > n) scr.text(4, scr.cols - 22, `${(s.top ?? 0) + 1}-${(s.top ?? 0) + items.length} OF ${total}`.padStart(20), { color: "white" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN TO SALE  PF7=BACK  PF8=FORWARD  ENTER=SEARCH OR SELECT");
		if (s.errSel) scr.cursorTo(s.errSel);
		else if (items.length && s.q) scr.cursorTo(`sel:${items[0].sku}`);
		else scr.cursorTo("q");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		const n = room(ctx.rows);
		if (inp.aid === pf(7)) {
			s.top = Math.max((s.top ?? 0) - n, 0);
			return s;
		}
		if (inp.aid === pf(8)) {
			if ((s.top ?? 0) + n < (s.total ?? 0)) s.top = (s.top ?? 0) + n;
			else s.msg = `${msgId(ctx, "2370I")} THIS IS THE LAST PAGE`;
			return s;
		}
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const sku of s.keys ?? []) {
			const code = (inp.fields[`sel:${sku}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			const fail = (msg: string) => {
				s.msg = msgId(ctx, msg);
				s.errSel = `sel:${sku}`;
				return withFill(s, { fields: { [`sel:${sku}`]: code }, cursor: s.errSel });
			};
			if (code !== "S") return fail(`2371E INVALID SELECTION CODE "${code}" - TYPE S`);
			const it = await findItem(ctx.env.DB, s.lane.store, sku);
			if (!it || it === "discontinued") return fail(`2372E ITEM ${sku} WAS JUST TAKEN OFF SALE`);
			const sale = s.back;
			sale.msg = sale.errField = undefined;
			// One of it, as a scan rings; pounds come from the scale.
			if (it.weighed) {
				sale.msg = `${msgId(ctx, "2373I")} ${it.desc} IS SOLD BY WEIGHT - KEY THE POUNDS AND PRESS ENTER`;
				sale.errField = "qty";
				return withFill(sale, { fields: { item: it.sku, qty: "" }, cursor: "qty" });
			}
			const err = ring(ctx, sale, it, 1000);
			if (err) return fail(err);
			return sale;
		}
		// No selection: search for what was typed.
		s.q = (inp.fields.q ?? "").trim().toUpperCase();
		s.top = 0;
		return s;
	},
}));
