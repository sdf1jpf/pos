import { clock, header, invalidKey, keys, lpad, message, msgId, newScreen, pad, panel, pf } from "@greenscreen-dev/worker";
import {
	addCoupon, addPromotion, couponValue, getCoupon, getPromotion, listCoupons, listPromotions, updateCoupon, updatePromotion,
	type CouponInput, type Promotion, type PromotionInput,
} from "../data/promos";
import type { Env } from "../env";
import { dollars } from "../money";
import { FIRST, form, guarded, listRows, pick, refused, rowCount, rule, scroll, selected } from "./common";
import type { CouponsState, CouponState, PromotionsState, PromotionState, PosCtx } from "./types";

// What a promotion does, in a few words: "2 FOR 5.00", "BUY 1 GET 1 FREE".
export function deal(p: Pick<Promotion, "kind" | "qty" | "free" | "pct" | "price">): string {
	if (p.kind === "SALE") return `NOW ${dollars(p.price)}`;
	if (p.kind === "MIX") return `${p.qty} FOR ${dollars(p.price)}`;
	return `BUY ${p.qty} GET ${p.free} ${p.pct === 100 ? "FREE" : `${p.pct}% OFF`}`;
}

// POS140 PROMOTIONS: sale prices, BOGOs and mix and matches the registers
// apply by themselves. S shows one for update; PF5 adds one.

export const promotions = guarded("items", panel<PromotionsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS140");
		header(scr, ctx, "PROMOTIONS");
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE", { color: "blue" });
		const { promotions, total } = await listPromotions(ctx.env.DB, s.top ?? 0, listRows(ctx));
		s.keys = promotions.map((p) => String(p.id));
		s.total = total;
		rowCount(scr, s.top ?? 0, promotions.length, total);
		scr.text(6, 2, "S    ID NAME                     DEAL                 STORE STARTS           ST", { color: "white", bright: true });
		rule(scr, 7);
		if (total === 0) scr.text(FIRST, 4, "NO PROMOTIONS YET - PF5 TO ADD ONE", { color: "blue" });
		promotions.forEach((p, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${p.id}`, "", { bright: s.errSel === `sel:${p.id}` });
			scr.text(row, 4, lpad(p.id, 5), { color: "turquoise" });
			scr.text(row, 10, pad(p.name, 24), { color: "green" });
			scr.text(row, 35, pad(deal(p), 20), { color: "green" });
			scr.text(row, 56, pad(p.store === null ? "ALL" : String(p.store), 5), { color: "green" });
			scr.text(row, 62, pad(p.starts, 16), { color: "green" });
			scr.text(row, 79, p.status, { color: p.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		if (promotions.length > 0) scr.cursorTo(`sel:${promotions[0].id}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "promotion", back: s } satisfies PromotionState;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code !== "S") {
				s.msg = `${msgId(ctx, "1401E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
				s.errSel = x.field;
				return s;
			}
			return { p: "promotion", back: s, id: Number(x.key) } satisfies PromotionState;
		}
		return s;
	},
}));

// POS141 PROMOTION: one promotion, to add or update.

const PROMO_FIELDS = ["name", "kind", "qty", "free", "pct", "price", "store", "starts", "ends", "status", "items"] as const;

export const promotion = guarded("items", panel<PromotionState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS141");
		const p = s.id !== undefined ? await getPromotion(ctx.env.DB, s.id) : undefined;
		header(scr, ctx, p ? `PROMOTION ${p.id}` : "ADD PROMOTION");
		if (s.id !== undefined && !p) {
			message(scr, `${msgId(ctx, "1402E")} PROMOTION ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (p) s.version ??= p.version;
		form(scr, [
			{ row: 4, label: "NAME", name: "name", len: 24, value: p?.name ?? "", note: "PRINTED ON THE RECEIPT" },
			{ row: 5, label: "KIND", name: "kind", len: 4, value: p?.kind ?? "", note: "SALE=SALE PRICE  BOGO=BUY X GET Y  MIX=X FOR $" },
			{ row: 7, label: "BUY QTY", name: "qty", len: 2, value: p ? String(p.qty) : "", numeric: true, note: "BOGO: HOW MANY TO BUY  MIX: HOW MANY FOR THE PRICE" },
			{ row: 8, label: "GET QTY", name: "free", len: 2, value: p?.kind === "BOGO" ? String(p.free) : "", numeric: true, note: "BOGO: HOW MANY MORE AT THE DISCOUNT" },
			{ row: 9, label: "PERCENT OFF", name: "pct", len: 3, value: p?.kind === "BOGO" ? String(p.pct) : "", numeric: true, note: "BOGO: 100 IS FREE, 50 IS HALF PRICE" },
			{ row: 10, label: "PRICE", name: "price", len: 9, value: p && p.kind !== "BOGO" ? dollars(p.price) : "", note: "SALE: EACH OR PER LB  MIX: FOR THE GROUP" },
			{ row: 12, label: "STORE", name: "store", len: 3, value: p?.store ? String(p.store) : "", numeric: true, note: "BLANK FOR EVERY STORE" },
			{ row: 13, label: "STARTS", name: "starts", len: 16, value: p?.starts ?? "", note: "YYYY-MM-DD HH:MM, STORE TIME" },
			{ row: 14, label: "ENDS", name: "ends", len: 16, value: p?.ends ?? "", note: "BLANK: NO END" },
			{ row: 15, label: "STATUS", name: "status", len: 1, value: p?.status ?? "A", note: "A=ACTIVE  I=INACTIVE" },
			{ row: 17, label: "ITEMS", name: "items", len: 58, value: p?.skus.join(",") ?? "" },
		], s.errField);
		scr.text(18, 20, "THE SKUS ON PROMOTION, SEPARATED BY COMMAS", { color: "blue" });
		if (p) scr.text(20, 2, `${deal(p)}   LAST CHANGED ${clock(ctx, p.updatedAt)} BY ${p.updatedBy}   VERSION ${p.version}`, { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, `PF1=HELP  PF3=RETURN  ENTER=${p ? "UPDATE" : "ADD"}`);
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
		const typed: PromotionInput = pick(inp, PROMO_FIELDS);
		try {
			if (s.id !== undefined) {
				const p = await updatePromotion(ctx.env.DB, ctx.user, s.id, s.version ?? 0, typed);
				s.version = p.version;
				s.msg = `${msgId(ctx, "1403I")} PROMOTION ${p.id} UPDATED`;
			} else {
				const p = await addPromotion(ctx.env.DB, ctx.user, typed);
				s.id = p.id;
				s.version = p.version;
				s.msg = `${msgId(ctx, "1404I")} PROMOTION ${p.id} ADDED`;
			}
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "1405");
		}
	},
}));

// POS150 COUPONS: codes the register takes, scanned or keyed in the item
// field. S shows one for update; PF5 adds one.

export const coupons = guarded("items", panel<CouponsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS150");
		header(scr, ctx, "COUPONS");
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE", { color: "blue" });
		const { coupons, total } = await listCoupons(ctx.env.DB, s.top ?? 0, listRows(ctx));
		s.keys = coupons.map((c) => c.code);
		s.total = total;
		rowCount(scr, s.top ?? 0, coupons.length, total);
		scr.text(6, 2, "S CODE           DESCRIPTION              VALUE  ON             STARTS     ST", { color: "white", bright: true });
		rule(scr, 7);
		if (total === 0) scr.text(FIRST, 4, "NO COUPONS YET - PF5 TO ADD ONE", { color: "blue" });
		coupons.forEach((c, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${c.code}`, "", { bright: s.errSel === `sel:${c.code}` });
			scr.text(row, 4, pad(c.code, 14), { color: "turquoise" });
			scr.text(row, 19, pad(c.desc, 24), { color: "green" });
			scr.text(row, 44, lpad(couponValue(c), 6), { color: "green" });
			scr.text(row, 51, pad(c.sku ? `SKU ${c.sku}` : c.dept !== null ? `DEPT ${c.dept}` : "SALE", 14), { color: "green" });
			scr.text(row, 66, pad(c.starts.slice(0, 10), 10), { color: "green" });
			scr.text(row, 79, c.status, { color: c.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		if (coupons.length > 0) scr.cursorTo(`sel:${coupons[0].code}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "coupon", back: s } satisfies CouponState;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code !== "S") {
				s.msg = `${msgId(ctx, "1501E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
				s.errSel = x.field;
				return s;
			}
			return { p: "coupon", back: s, code: x.key } satisfies CouponState;
		}
		return s;
	},
}));

// POS151 COUPON: one coupon, to add or update.

const COUPON_FIELDS = ["code", "desc", "value", "sku", "dept", "minTotal", "starts", "ends", "status"] as const;

export const coupon = guarded("items", panel<CouponState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS151");
		const c = s.code ? await getCoupon(ctx.env.DB, s.code) : undefined;
		header(scr, ctx, c ? `COUPON ${c.code}` : "ADD COUPON");
		if (s.code && !c) {
			message(scr, `${msgId(ctx, "1502E")} COUPON ${s.code} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (c) s.version ??= c.version;
		form(scr, [
			{ row: 4, label: "CODE", name: "code", len: 14, value: c?.code ?? "", protect: !!c, note: c ? "" : "WHAT IS SCANNED OR KEYED" },
			{ row: 5, label: "DESCRIPTION", name: "desc", len: 24, value: c?.desc ?? "", note: "PRINTED ON THE RECEIPT" },
			{ row: 7, label: "VALUE", name: "value", len: 7, value: c ? couponValue(c) : "", note: "10% OFF, OR AN AMOUNT OFF SUCH AS 2.00" },
			{ row: 8, label: "SKU", name: "sku", len: 14, value: c?.sku ?? "", note: "OFF THIS ITEM ONLY" },
			{ row: 9, label: "DEPARTMENT", name: "dept", len: 3, value: c?.dept !== null && c?.dept !== undefined ? String(c.dept) : "", numeric: true, note: "OR THIS DEPARTMENT; BOTH BLANK: THE SALE" },
			{ row: 10, label: "MINIMUM", name: "minTotal", len: 9, value: c?.minTotal ? dollars(c.minTotal) : "", note: "WHAT THE SALE MUST COME TO FIRST" },
			{ row: 12, label: "STARTS", name: "starts", len: 16, value: c?.starts ?? "", note: "YYYY-MM-DD HH:MM, STORE TIME" },
			{ row: 13, label: "ENDS", name: "ends", len: 16, value: c?.ends ?? "", note: "BLANK: NO END" },
			{ row: 14, label: "STATUS", name: "status", len: 1, value: c?.status ?? "A", note: "A=ACTIVE  I=INACTIVE" },
		], s.errField);
		if (c) scr.text(16, 2, `LAST CHANGED ${clock(ctx, c.updatedAt)} BY ${c.updatedBy}   VERSION ${c.version}`, { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, `PF3=RETURN  ENTER=${c ? "UPDATE" : "ADD"}`);
		scr.cursorTo(s.errField ?? (c ? "desc" : "code"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed: CouponInput = { ...pick(inp, COUPON_FIELDS), ...(s.code ? { code: s.code } : {}) };
		try {
			if (s.code) {
				const c = await updateCoupon(ctx.env.DB, ctx.user, s.code, s.version ?? 0, typed);
				s.version = c.version;
				s.msg = `${msgId(ctx, "1503I")} COUPON ${c.code} UPDATED`;
			} else {
				const c = await addCoupon(ctx.env.DB, ctx.user, typed);
				s.code = c.code;
				s.version = c.version;
				s.msg = `${msgId(ctx, "1504I")} COUPON ${c.code} ADDED`;
			}
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "1505");
		}
	},
}));
