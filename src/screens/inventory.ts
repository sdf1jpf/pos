import { clock, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, withFill, type Input } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { Invalid } from "../data/db";
import { getItem, listDepartments } from "../data/items";
import {
	adjust, cancelCount, cancelTransfer, countLines, getCount, getTransfer, ledger, listCounts, listStock, listTransfers, newCount, newTransfer,
	onHand, postCount, readQty, REASONS, receiveTransfer, sendTransfer, setCounted, showQty,
} from "../data/stock";
import { getStore, storeNumber } from "../data/stores";
import type { Env } from "../env";
import { FIRST, form, guarded, listRows, refused, rowCount, rule, scroll, selected } from "./common";
import type {
	AdjustState, CountsState, CountState, LedgerState, PosCtx, StockState, TransfersState, TransferState,
} from "./types";

// Inventory, menu 2. Maps are POS310 to POS331 (POS2xx is the register's).

// storeField reads a store number typed on a screen and checks the person
// may work on it, or says why not.
async function storeField(ctx: PosCtx, typed: string): Promise<number | string> {
	const n = storeNumber(typed);
	if (n === undefined) return "STORE MUST BE 1 TO 999";
	if (!(await getStore(ctx.env.DB, n))) return `STORE ${n} NOT FOUND`;
	if (!canStore((await who(ctx))!, n)) return `YOU MAY NOT WORK ON STORE ${n}`;
	return n;
}

// firstStore is where a person limited to some stores starts.
async function firstStore(ctx: PosCtx): Promise<number | undefined> {
	return (await who(ctx))!.stores[0];
}

const signed = (q: number, weighed: boolean) => (q > 0 ? "+" : "") + showQty(q, weighed);

// POS310 ON HAND: a store's stock by item. L shows an item's ledger, A
// adjusts it.

export const stock = guarded("inventory", panel<StockState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS310");
		header(scr, ctx, "ON HAND");
		s.store ??= await firstStore(ctx);
		const store = s.store !== undefined ? await getStore(ctx.env.DB, s.store) : undefined;
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		scr.text(3, 18, pad(store?.name ?? "", 20), { color: "white" });
		label(scr, 4, 2, "SEARCH ==>");
		scr.input(4, 13, 20, "q", s.q ?? "", { bright: s.errField === "q" });
		label(scr, 4, 36, "DEPT ===>");
		scr.input(4, 46, 3, "dept", s.dept ? String(s.dept) : "", { numeric: true, bright: s.errField === "dept" });
		scr.text(5, 2, "SELECT: L=LEDGER  A=ADJUST", { color: "blue" });
		scr.text(6, 2, "S SKU            DESCRIPTION                         DEPT     ON HAND", { color: "white", bright: true });
		rule(scr, 7);
		s.keys = [];
		if (!store) scr.text(FIRST, 4, "ENTER A STORE NUMBER TO SEE ITS STOCK", { color: "blue" });
		else {
			const { lines, total } = await listStock(ctx.env.DB, store.store, { q: s.q, dept: s.dept, offset: s.top ?? 0, limit: listRows(ctx) });
			s.keys = lines.map((l) => l.sku);
			s.total = total;
			rowCount(scr, s.top ?? 0, lines.length, total, 3);
			if (total === 0) scr.text(FIRST, 4, "NO ITEMS MATCH", { color: "blue" });
			lines.forEach((l, i) => {
				const row = FIRST + i;
				scr.input(row, 2, 1, `sel:${l.sku}`, "", { bright: s.errSel === `sel:${l.sku}` });
				scr.text(row, 4, pad(l.sku, 14), { color: "turquoise" });
				scr.text(row, 19, pad(l.desc, 35), { color: "green" });
				scr.text(row, 55, lpad(l.dept, 4), { color: "green" });
				scr.text(row, 60, lpad(showQty(l.onHand, l.weighed) + (l.weighed ? " LB" : ""), 12), { color: l.onHand < 0 ? "red" : "green" });
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADJUST  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? s.errSel ?? (s.keys.length ? `sel:${s.keys[0]}` : "store"));
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "adjust", back: s, store: s.store, token: crypto.randomUUID() } satisfies AdjustState;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		if (["store", "q", "dept"].some((f) => inp.modified.has(f)) || s.store === undefined) {
			const fail = (field: string, msg: string) => {
				s.msg = msgId(ctx, msg);
				s.errField = field;
				return withFill(s, { fields: inp.fields, cursor: field });
			};
			const n = await storeField(ctx, inp.fields.store ?? "");
			if (typeof n === "string") return fail("store", `3101E ${n}`);
			const d = (inp.fields.dept ?? "").trim();
			if (d && !/^\d{1,3}$/.test(d)) return fail("dept", "3102E DEPARTMENT MUST BE 1 TO 999, OR BLANK");
			s.store = n;
			s.q = (inp.fields.q ?? "").trim().toUpperCase();
			s.dept = d ? Number(d) : undefined;
			s.top = 0;
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "L") return { p: "ledger", back: s, store: s.store, sku: x.key } satisfies LedgerState;
			if (x.code === "A") return { p: "adjust", back: s, store: s.store, sku: x.key, token: crypto.randomUUID() } satisfies AdjustState;
			s.msg = `${msgId(ctx, "3103E")} INVALID SELECTION CODE "${x.code}" - TYPE L OR A`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS311 LEDGER: every move of an item at a store, newest first.

const KIND_TEXT: Record<string, string> = {
	SALE: "SALE", VOID: "POST-VOID", ADJUST: "ADJUSTED", COUNT: "COUNTED", XFEROUT: "SENT", XFERIN: "RECEIVED",
	RECEIVE: "PO RECEIVED", VRETURN: "TO VENDOR",
};

export const stockLedger = guarded("inventory", panel<LedgerState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS311");
		header(scr, ctx, `LEDGER - STORE ${s.store}`);
		const it = await getItem(ctx.env.DB, s.sku);
		const now = await onHand(ctx.env.DB, s.store, s.sku);
		const w = it?.weighed ?? false;
		scr.text(3, 2, `${s.sku}  ${it?.desc ?? ""}`, { color: "white", bright: true });
		scr.text(4, 2, `ON HAND ${showQty(now, w)}${w ? " LB" : ""}`, { color: "turquoise" });
		scr.text(6, 2, "WHEN             WHAT        REF                     QTY  REASON   BY", { color: "white", bright: true });
		rule(scr, 7);
		const { moves, total } = await ledger(ctx.env.DB, s.store, s.sku, s.top ?? 0, listRows(ctx));
		s.total = total;
		rowCount(scr, s.top ?? 0, moves.length, total);
		if (total === 0) scr.text(FIRST, 4, "NOTHING HAS MOVED THIS ITEM AT THIS STORE", { color: "blue" });
		moves.forEach((m, i) => {
			const row = FIRST + i;
			scr.text(row, 2, pad(clock(ctx, m.at), 16), { color: "green" });
			scr.text(row, 19, pad(KIND_TEXT[m.kind] ?? m.kind, 11), { color: "turquoise" });
			scr.text(row, 31, pad(m.ref.replace(/:.*$/, ""), 18), { color: "green" });
			scr.text(row, 50, lpad(signed(m.qty, w), 9), { color: m.qty < 0 ? "yellow" : "green" });
			scr.text(row, 61, pad(m.reason, 8), { color: "green" });
			scr.text(row, 70, pad(m.userid, 10), { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF5=ADJUST  PF7=UP  PF8=DOWN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},
	handle(ctx, s, inp) {
		s.msg = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(5)) return { p: "adjust", back: s, store: s.store, sku: s.sku, token: crypto.randomUUID() } satisfies AdjustState;
		if (inp.aid === pf(3) || inp.aid === pf(12) || inp.aid === "ENTER") return s.back;
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// POS312 ADJUST: on hand changed by hand, with a reason.

export const adjustStock = guarded("inventory", panel<AdjustState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS312");
		header(scr, ctx, "ADJUST ON HAND");
		s.store ??= await firstStore(ctx);
		const it = s.sku ? await getItem(ctx.env.DB, s.sku) : undefined;
		const now = it && s.store ? await onHand(ctx.env.DB, s.store, it.sku) : undefined;
		form(scr, [
			{ row: 4, label: "STORE", name: "store", len: 3, value: s.store ? String(s.store) : "", numeric: true },
			{ row: 5, label: "ITEM", name: "sku", len: 14, value: s.sku ?? "", note: it ? it.desc : "SKU OR UPC" },
			{ row: 6, label: "CHANGE", name: "qty", len: 10, value: "", note: "+ MORE OR - FEWER, E.G. -2 (POUNDS FOR A WEIGHED ITEM)" },
			{ row: 7, label: "REASON", name: "reason", len: 2, value: "", note: Object.entries(REASONS).map(([k, v]) => `${k}=${v}`).join(" ") },
		], s.errField);
		if (now !== undefined) scr.text(9, 2, `ON HAND AT STORE ${s.store}: ${showQty(now, it!.weighed)}${it!.weighed ? " LB" : ""}`, { color: "turquoise" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  ENTER=ADJUST");
		scr.cursorTo(s.errField ?? (s.sku ? "qty" : s.store ? "sku" : "store"));
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
		const n = await storeField(ctx, inp.fields.store ?? "");
		if (typeof n === "string") return fail("store", `3121E ${n}`);
		s.store = n;
		const code = (inp.fields.sku ?? "").trim().toUpperCase();
		const it = code ? (await getItem(ctx.env.DB, code)) ?? (await itemByUpc(ctx.env.DB, code)) : undefined;
		if (!it) return fail("sku", code ? `3122E ITEM ${code} NOT FOUND` : "3123E KEY THE ITEM'S SKU OR UPC");
		s.sku = it.sku;
		const typed = (inp.fields.qty ?? "").trim();
		if (!typed) {
			// Only the item keyed: show what is on hand, to adjust next.
			return s;
		}
		const qty = readQty(typed, it.weighed, true);
		if (qty === undefined) return fail("qty", it.weighed ? "3124E KEY THE POUNDS, E.G. -1.25" : "3125E KEY A WHOLE NUMBER, E.G. 3 OR -2");
		try {
			await adjust(ctx.env.DB, ctx.user, s.token, n, it.sku, qty, (inp.fields.reason ?? "").trim().toUpperCase());
		} catch (e) {
			return refused(ctx, s, inp, e, "3126");
		}
		s.token = crypto.randomUUID();
		s.msg = `${msgId(ctx, "3127I")} ${it.sku} AT STORE ${n} ADJUSTED ${signed(qty, it.weighed)}`;
		return s;
	},
}));

async function itemByUpc(db: D1Database, upc: string) {
	const r = await db.prepare("SELECT sku FROM items WHERE upc = ?").bind(upc).first<{ sku: string }>();
	return r ? getItem(db, r.sku) : undefined;
}

// POS320 COUNTS: cycle and full counts. PF5 starts one at the store keyed,
// for the department keyed (a cycle count) or every item (blank). S opens
// one to key what was counted.

const COUNT_STATUS = { O: "OPEN", P: "POSTED", X: "CANCELLED" } as const;

export const counts = guarded("inventory", panel<CountsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS320");
		header(scr, ctx, "COUNTS");
		const w = (await who(ctx))!;
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : w.stores[0] ? String(w.stores[0]) : "", { numeric: true, bright: s.errField === "store" });
		label(scr, 3, 20, "DEPT ===>");
		scr.input(3, 30, 3, "dept", "", { numeric: true, bright: s.errField === "dept" });
		scr.text(3, 35, "FOR PF5: BLANK DEPT COUNTS EVERY ITEM", { color: "blue" });
		scr.text(5, 2, "SELECT: S=SHOW/COUNT", { color: "blue" });
		scr.text(6, 2, "S    NO. STORE KIND   DEPT STARTED          BY          COUNTED  STATUS", { color: "white", bright: true });
		rule(scr, 7);
		const { counts, total } = await listCounts(ctx.env.DB, w.stores, s.top ?? 0, listRows(ctx));
		s.keys = counts.map((c) => String(c.id));
		s.total = total;
		rowCount(scr, s.top ?? 0, counts.length, total, 4);
		if (total === 0) scr.text(FIRST, 4, "NO COUNTS YET - KEY A STORE AND PRESS PF5 TO START ONE", { color: "blue" });
		counts.forEach((c, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${c.id}`, "", { bright: s.errSel === `sel:${c.id}` });
			scr.text(row, 4, lpad(c.id, 6), { color: "turquoise" });
			scr.text(row, 11, lpad(c.store, 5), { color: "green" });
			scr.text(row, 17, pad(c.kind, 6), { color: "green" });
			scr.text(row, 24, lpad(c.dept ?? "", 4), { color: "green" });
			scr.text(row, 29, pad(clock(ctx, c.createdAt), 16), { color: "green" });
			scr.text(row, 46, pad(c.createdBy, 10), { color: "green" });
			scr.text(row, 57, lpad(`${c.counted}/${c.lines}`, 9), { color: "green" });
			scr.text(row, 68, COUNT_STATUS[c.status], { color: c.status === "O" ? "yellow" : "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=START A COUNT  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? s.errSel ?? (s.keys.length ? `sel:${s.keys[0]}` : "store"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		if (inp.aid === pf(5)) {
			const n = await storeField(ctx, inp.fields.store ?? "");
			if (typeof n === "string") return fail("store", `3201E ${n}`);
			s.store = n;
			const d = (inp.fields.dept ?? "").trim();
			let dept: number | undefined;
			if (d) {
				dept = Number(d);
				const dp = (await listDepartments(ctx.env.DB)).find((x) => x.dept === dept);
				if (!/^\d{1,3}$/.test(d) || !dp) return fail("dept", `3202E DEPARTMENT ${d} NOT FOUND`);
			}
			const id = await newCount(ctx.env.DB, ctx.user, n, dept);
			return { p: "count", back: s, id, msg: `${msgId(ctx, "3203I")} COUNT ${id} STARTED - KEY WHAT IS ON THE SHELF` } satisfies CountState;
		}
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "count", back: s, id: Number(x.key) } satisfies CountState;
			s.msg = `${msgId(ctx, "3204E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS321 COUNT: key what is on the shelf beside each item; Enter saves.
// PF10 posts the count, setting on hand to what was counted; items left
// blank keep their on hand. PF11 cancels it.

export const count = guarded("inventory", panel<CountState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS321");
		const c = await getCount(ctx.env.DB, s.id);
		header(scr, ctx, `COUNT ${s.id}`);
		if (!c) {
			message(scr, `${msgId(ctx, "3211E")} COUNT ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		const open = c.status === "O";
		scr.text(3, 2, `STORE ${c.store}  ${c.kind === "CYCLE" ? `CYCLE COUNT OF DEPT ${c.dept}` : "FULL COUNT"}  ${COUNT_STATUS[c.status]}`, { color: "white", bright: true });
		scr.text(4, 2, `${c.counted} OF ${c.lines} COUNTED`, { color: "turquoise" });
		scr.text(6, 2, "SKU            DESCRIPTION                       ON HAND    COUNTED     DIFF", { color: "white", bright: true });
		rule(scr, 7);
		const lines = await countLines(ctx.env.DB, c, s.top ?? 0, listRows(ctx));
		s.keys = lines.map((l) => l.sku);
		s.total = c.lines;
		rowCount(scr, s.top ?? 0, lines.length, c.lines);
		lines.forEach((l, i) => {
			const row = FIRST + i;
			const f = `n:${l.sku}`;
			scr.text(row, 2, pad(l.sku, 14), { color: "turquoise" });
			scr.text(row, 17, pad(l.desc, 32), { color: "green" });
			scr.text(row, 50, lpad(showQty(l.onHand, l.weighed), 8), { color: "green" });
			const v = l.counted === null ? "" : showQty(l.counted, l.weighed);
			if (open) scr.input(row, 61, 9, f, v, { bright: s.errSel === f });
			else scr.text(row, 61, lpad(v, 9), { color: "green" });
			if (l.counted !== null && l.counted !== l.onHand) {
				scr.text(row, 72, lpad(signed(l.counted - l.onHand, l.weighed), 8), { color: "yellow" });
			}
		});
		message(scr, s.msg ?? "");
		keys(scr, open ? "PF3=RETURN  PF7=UP  PF8=DOWN  PF10=POST  PF11=CANCEL COUNT  ENTER=SAVE" : "PF3=RETURN  PF7=UP  PF8=DOWN");
		if (open && lines.length) scr.cursorTo(s.errSel ?? `n:${lines[0].sku}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		const c = await getCount(ctx.env.DB, s.id);
		if (inp.aid === pf(3) || inp.aid === pf(12) || !c) return s.back;
		if (!canStore((await who(ctx))!, c.store)) {
			s.msg = `${msgId(ctx, "3212E")} YOU MAY NOT WORK ON STORE ${c.store}`;
			return s;
		}
		// What was keyed is saved before paging, posting or anything else.
		if (c.status === "O") {
			const saved = await saveCounted(ctx, s, inp);
			if (saved !== true) return saved;
		}
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(10) && c.status === "O") {
			if (!(await getCount(ctx.env.DB, s.id))!.counted) {
				s.msg = `${msgId(ctx, "3213E")} NOTHING HAS BEEN COUNTED YET`;
				return s;
			}
			s.msg = (await postCount(ctx.env.DB, ctx.user, s.id))
				? `${msgId(ctx, "3214I")} COUNT ${s.id} POSTED - ON HAND IS NOW WHAT WAS COUNTED`
				: `${msgId(ctx, "3215W")} COUNT ${s.id} WAS ALREADY CLOSED`;
			return s;
		}
		if (inp.aid === pf(11) && c.status === "O") {
			await cancelCount(ctx.env.DB, ctx.user, s.id);
			s.msg = `${msgId(ctx, "3216I")} COUNT ${s.id} CANCELLED - ON HAND IS UNCHANGED`;
			return s;
		}
		if (inp.aid !== "ENTER") s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// saveCounted saves the counted quantities keyed on screen. It returns true,
// or the screen with the bad one marked.
async function saveCounted(ctx: PosCtx, s: CountState, inp: Input): Promise<true | CountState> {
	const c = (await getCount(ctx.env.DB, s.id))!;
	const shown = await countLines(ctx.env.DB, c, s.top ?? 0, (s.keys ?? []).length || 1);
	const out: [string, number | null][] = [];
	for (const l of shown) {
		const f = `n:${l.sku}`;
		if (!inp.modified.has(f)) continue;
		const typed = (inp.fields[f] ?? "").trim();
		const q = typed === "" ? null : /^0+(\.0*)?$/.test(typed) ? 0 : readQty(typed, l.weighed);
		if (q === undefined) {
			s.msg = `${msgId(ctx, "3217E")} ${l.sku}: ${l.weighed ? "KEY THE POUNDS, E.G. 12.5" : "KEY A WHOLE NUMBER"}, OR BLANK`;
			s.errSel = f;
			return withFill(s, { fields: Object.fromEntries([...inp.modified].map((m) => [m, inp.fields[m] ?? ""])), cursor: f });
		}
		out.push([l.sku, q]);
	}
	await setCounted(ctx.env.DB, s.id, out);
	if (out.length && inp.aid === "ENTER") s.msg = `${msgId(ctx, "3218I")} ${out.length} COUNT(S) SAVED`;
	return true;
}

// POS330 TRANSFERS: stock moved between stores. S shows one; PF5 starts
// one.

const XFER_STATUS = { O: "OPEN", S: "SENT", R: "RECEIVED", X: "CANCELLED" } as const;

export const transfers = guarded("inventory", panel<TransfersState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS330");
		header(scr, ctx, "TRANSFERS");
		const w = (await who(ctx))!;
		scr.text(5, 2, "SELECT: S=SHOW", { color: "blue" });
		scr.text(6, 2, "S    NO.  FROM    TO  STARTED          BY          STATUS", { color: "white", bright: true });
		rule(scr, 7);
		const { transfers, total } = await listTransfers(ctx.env.DB, w.stores, s.top ?? 0, listRows(ctx));
		s.keys = transfers.map((t) => String(t.id));
		s.total = total;
		rowCount(scr, s.top ?? 0, transfers.length, total);
		if (total === 0) scr.text(FIRST, 4, "NO TRANSFERS YET - PF5 TO START ONE", { color: "blue" });
		transfers.forEach((t, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${t.id}`, "", { bright: s.errSel === `sel:${t.id}` });
			scr.text(row, 4, lpad(t.id, 6), { color: "turquoise" });
			scr.text(row, 11, lpad(t.from, 5), { color: "green" });
			scr.text(row, 17, lpad(t.to, 5), { color: "green" });
			scr.text(row, 24, pad(clock(ctx, t.createdAt), 16), { color: "green" });
			scr.text(row, 41, pad(t.createdBy, 10), { color: "green" });
			scr.text(row, 53, XFER_STATUS[t.status], { color: t.status === "O" || t.status === "S" ? "yellow" : "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=START A TRANSFER  PF7=UP  PF8=DOWN");
		if (transfers.length) scr.cursorTo(s.errSel ?? `sel:${transfers[0].id}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "transfer", back: s } satisfies TransferState;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "transfer", back: s, id: Number(x.key) } satisfies TransferState;
			s.msg = `${msgId(ctx, "3301E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS331 TRANSFER: a new transfer keyed (from, to, up to ten items), or one
// to send (PF10, at the sending store), cancel (PF11) or receive (PF10, at
// the receiving store, keying what arrived where it differs).

const NEW_LINES = 10;

export const transfer = guarded("inventory", panel<TransferState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS331");
		if (s.id === undefined) {
			header(scr, ctx, "START A TRANSFER");
			const w = (await who(ctx))!;
			label(scr, 3, 2, "FROM STORE ===>");
			scr.input(3, 18, 3, "from", w.stores[0] ? String(w.stores[0]) : "", { numeric: true, bright: s.errField === "from" });
			label(scr, 3, 24, "TO STORE ===>");
			scr.input(3, 38, 3, "to", "", { numeric: true, bright: s.errField === "to" });
			scr.text(5, 2, "SKU               QTY", { color: "white", bright: true });
			rule(scr, 6);
			for (let i = 0; i < NEW_LINES; i++) {
				scr.input(7 + i, 2, 14, `sku:${i}`, "", { bright: s.errField === `sku:${i}` });
				scr.input(7 + i, 18, 9, `qty:${i}`, "", { bright: s.errField === `qty:${i}` });
			}
			message(scr, s.msg ?? "");
			keys(scr, "PF3=RETURN  ENTER=START");
			scr.cursorTo(s.errField ?? "to");
			return scr;
		}
		const t = await getTransfer(ctx.env.DB, s.id);
		header(scr, ctx, `TRANSFER ${s.id}`);
		if (!t) {
			message(scr, `${msgId(ctx, "3311E")} TRANSFER ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		scr.text(3, 2, `FROM STORE ${t.from} TO STORE ${t.to}  ${XFER_STATUS[t.status]}`, { color: "white", bright: true });
		const when = t.receivedAt ? `RECEIVED ${clock(ctx, t.receivedAt)}` : t.sentAt ? `SENT ${clock(ctx, t.sentAt)}` : `STARTED ${clock(ctx, t.createdAt)} BY ${t.createdBy}`;
		scr.text(4, 2, when, { color: "turquoise" });
		scr.text(6, 2, "SKU            DESCRIPTION                          SENT   RECEIVED", { color: "white", bright: true });
		rule(scr, 7);
		const receiving = t.status === "S";
		t.lines.slice(0, listRows(ctx)).forEach((l, i) => {
			const row = FIRST + i;
			scr.text(row, 2, pad(l.sku, 14), { color: "turquoise" });
			scr.text(row, 17, pad(l.desc, 34), { color: "green" });
			scr.text(row, 52, lpad(showQty(l.qty, l.weighed), 8), { color: "green" });
			if (receiving) scr.input(row, 62, 9, `r:${l.sku}`, "", { bright: s.errField === `r:${l.sku}` });
			else if (l.received !== null) scr.text(row, 62, lpad(showQty(l.received, l.weighed), 9), { color: l.received === l.qty ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, t.status === "O" ? "PF3=RETURN  PF10=SEND  PF11=CANCEL" : receiving ? "PF3=RETURN  PF10=RECEIVE (BLANK: ALL ARRIVED)" : "PF3=RETURN");
		if (receiving && t.lines.length) scr.cursorTo(s.errField ?? `r:${t.lines[0].sku}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		if (s.id === undefined) {
			if (inp.aid !== "ENTER") {
				s.msg = invalidKey(ctx, inp.aid);
				return s;
			}
			const from = await storeField(ctx, inp.fields.from ?? "");
			if (typeof from === "string") return fail("from", `3312E ${from}`);
			const to = storeNumber(inp.fields.to ?? "");
			if (to === undefined || !(await getStore(ctx.env.DB, to))) return fail("to", "3313E KEY THE STORE IT GOES TO");
			try {
				const lines = Array.from({ length: NEW_LINES }, (_, i) => ({ sku: inp.fields[`sku:${i}`] ?? "", qty: inp.fields[`qty:${i}`] ?? "" }));
				s.id = await newTransfer(ctx.env.DB, ctx.user, from, to, lines);
			} catch (e) {
				if (!(e instanceof Invalid)) throw e;
				return fail(e.field, `3314E ${e.message}`);
			}
			s.msg = `${msgId(ctx, "3315I")} TRANSFER ${s.id} STARTED - PF10 SENDS IT`;
			return s;
		}
		const t = await getTransfer(ctx.env.DB, s.id);
		if (!t) return s.back;
		const w = (await who(ctx))!;
		if (inp.aid === pf(10) && t.status === "O") {
			if (!canStore(w, t.from)) return fail("", `3316E ONLY STORE ${t.from} CAN SEND IT`);
			s.msg = (await sendTransfer(ctx.env.DB, ctx.user, t.id))
				? `${msgId(ctx, "3317I")} TRANSFER ${t.id} SENT - STORE ${t.from}'S ON HAND IS LESS` : `${msgId(ctx, "3318W")} TRANSFER ${t.id} WAS ALREADY SENT`;
			return s;
		}
		if (inp.aid === pf(11) && t.status === "O") {
			if (!canStore(w, t.from)) return fail("", `3316E ONLY STORE ${t.from} CAN CANCEL IT`);
			await cancelTransfer(ctx.env.DB, ctx.user, t.id);
			s.msg = `${msgId(ctx, "3319I")} TRANSFER ${t.id} CANCELLED`;
			return s;
		}
		if (inp.aid === pf(10) && t.status === "S") {
			if (!canStore(w, t.to)) return fail("", `3320E ONLY STORE ${t.to} CAN RECEIVE IT`);
			const got: [string, number][] = [];
			for (const l of t.lines) {
				const f = `r:${l.sku}`;
				const typed = (inp.fields[f] ?? "").trim();
				if (!typed) continue;
				const q = /^0+(\.0*)?$/.test(typed) ? 0 : readQty(typed, l.weighed);
				if (q === undefined) return fail(f, `3321E ${l.sku}: ${l.weighed ? "KEY THE POUNDS, E.G. 12.5" : "KEY A WHOLE NUMBER"}, OR BLANK FOR ALL`);
				got.push([l.sku, q]);
			}
			s.msg = (await receiveTransfer(ctx.env.DB, ctx.user, t.id, got))
				? `${msgId(ctx, "3322I")} TRANSFER ${t.id} RECEIVED AT STORE ${t.to}` : `${msgId(ctx, "3323W")} TRANSFER ${t.id} WAS ALREADY RECEIVED`;
			return s;
		}
		if (inp.aid !== "ENTER") s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));
