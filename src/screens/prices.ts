import { header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { priceBook, setPrice } from "../data/items";
import { getStore, storeNumber } from "../data/stores";
import type { Env } from "../env";
import { cents, dollars } from "../money";
import { FIRST, guarded, listRows, rowCount, rule, scroll } from "./common";
import type { PricesState } from "./types";

// POS130 PRICE BOOK: a store's prices. An item sells at its base price
// unless the store has its own; type a price in STORE PRICE to set one,
// blank it to go back to the base price. Managers see only their stores.

export const prices = guarded("prices", panel<PricesState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS130");
		header(scr, ctx, "PRICE BOOK");
		const w = (await who(ctx))!;
		if (s.store === undefined && w.stores.length > 0) s.store = w.stores[0];
		const store = s.store !== undefined ? await getStore(ctx.env.DB, s.store) : undefined;
		label(scr, 4, 2, "STORE ===>");
		scr.input(4, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		scr.text(4, 18, pad(store?.name ?? "", 20), { color: "white" });
		label(scr, 5, 2, "SEARCH ==>");
		scr.input(5, 13, 20, "q", s.q ?? "", { bright: s.errField === "q" });
		scr.text(6, 2, "SKU            DESCRIPTION                        BASE  STORE PRICE", { color: "white", bright: true });
		rule(scr, 7);
		s.keys = [];
		if (!store) {
			scr.text(FIRST, 2, "ENTER A STORE NUMBER TO SEE ITS PRICES", { color: "blue" });
		} else {
			const rows = listRows(ctx);
			const { lines, total } = await priceBook(ctx.env.DB, store.store, { q: s.q, offset: s.top ?? 0, limit: rows });
			s.keys = lines.map((l) => l.sku);
			s.total = total;
			rowCount(scr, s.top ?? 0, lines.length, total);
			if (total === 0) scr.text(FIRST, 2, "NO ITEMS MATCH", { color: "blue" });
			lines.forEach((l, i) => {
				const row = FIRST + i;
				const f = `price:${l.sku}`;
				scr.text(row, 2, pad(l.sku, 14), { color: "turquoise" });
				scr.text(row, 17, pad(l.desc + (l.weighed ? " /LB" : ""), 30), { color: "green" });
				scr.text(row, 48, lpad(dollars(l.base), 9), { color: "green" });
				scr.input(row, 59, 9, f, l.store === undefined ? "" : dollars(l.store), { bright: s.errField === f });
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF7=UP  PF8=DOWN  ENTER=SAVE");
		scr.cursorTo(s.errField ?? (s.keys.length > 0 ? `price:${s.keys[0]}` : "store"));
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const w = (await who(ctx))!;
		if (inp.modified.has("store") || inp.modified.has("q")) {
			const typed = (inp.fields.store ?? "").trim();
			const n = storeNumber(typed);
			const fail = (msg: string) => {
				s.msg = `${msgId(ctx, msg)}`;
				s.errField = "store";
				return withFill(s, { fields: { store: typed, q: inp.fields.q ?? "" }, cursor: "store" });
			};
			if (n === undefined) return fail("0301E STORE MUST BE 1 TO 999");
			if (!(await getStore(ctx.env.DB, n))) return fail(`0302E STORE ${n} NOT FOUND`);
			if (!canStore(w, n)) return fail(`0303E YOU MAY NOT CHANGE STORE ${n}'S PRICES`);
			s.store = n;
			s.q = (inp.fields.q ?? "").trim().toUpperCase();
			s.top = 0;
			return s;
		}
		if (s.store === undefined || !canStore(w, s.store)) return s;
		// Check every changed price before saving any.
		const changes: [string, number | undefined][] = [];
		for (const sku of s.keys ?? []) {
			const f = `price:${sku}`;
			if (!inp.modified.has(f)) continue;
			const typed = (inp.fields[f] ?? "").trim();
			const price = typed === "" ? undefined : cents(typed);
			if (typed !== "" && price === undefined) {
				s.msg = `${msgId(ctx, "0304E")} PRICE FOR ${sku} MUST BE DOLLARS AND CENTS, E.G. 2.49, OR BLANK`;
				s.errField = f;
				return withFill(s, { fields: Object.fromEntries([...inp.modified].map((m) => [m, inp.fields[m] ?? ""])), cursor: f });
			}
			changes.push([sku, price]);
		}
		for (const [sku, price] of changes) await setPrice(ctx.env.DB, ctx.user, s.store, sku, price);
		if (changes.length > 0) s.msg = `${msgId(ctx, "0305I")} ${changes.length} PRICE(S) SAVED FOR STORE ${s.store}`;
		return s;
	},
}));
