import { clock, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, stamp, withFill, type Input } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { Invalid } from "../data/db";
import {
	addVendor, cancelPo, getPo, getVendor, lineCost, listPos, listVendors, newPo, orderPo, PO_STATUS, readDate, readPoLines,
	receivePo, reorderPoints, returnToVendor, setReorder, suggest, updateVendor, type VendorInput,
} from "../data/purchasing";
import { readQty, showQty } from "../data/stock";
import { getStore, storeNumber } from "../data/stores";
import type { Env } from "../env";
import { dollars } from "../money";
import { FIRST, form, guarded, listRows, pick, refused, rowCount, rule, scroll, selected } from "./common";
import type {
	PoState, PosCtx, PosState, ReorderState, SuggestState, VendorReturnState, VendorsState, VendorState,
} from "./types";

// Purchasing, menu 3. Maps are POS360 to POS380.

async function storeField(ctx: PosCtx, typed: string): Promise<number | string> {
	const n = storeNumber(typed);
	if (n === undefined) return "STORE MUST BE 1 TO 999";
	if (!(await getStore(ctx.env.DB, n))) return `STORE ${n} NOT FOUND`;
	if (!canStore((await who(ctx))!, n)) return `YOU MAY NOT WORK ON STORE ${n}`;
	return n;
}

const homeStore = async (ctx: PosCtx) => {
	const w = (await who(ctx))!;
	return w.stores[0] ? String(w.stores[0]) : "";
};

const zero = (s: string) => /^0+(\.0*)?$/.test(s.trim());

// failAt marks a field wrong, keeping what was typed.
function failAt<S extends { msg?: string; errField?: string }>(ctx: PosCtx, s: S, inp: Input, field: string, msg: string): S {
	s.msg = msgId(ctx, msg);
	s.errField = field;
	return withFill(s as S & { p: string }, { fields: inp.fields, cursor: field }) as S;
}

// picked says whether a different store or vendor was keyed than the one
// shown.
const picked = (inp: Input, s: { store?: number; vendor?: string }) =>
	(inp.fields.store ?? "").trim() !== String(s.store ?? "") || (inp.fields.vendor ?? "").trim().toUpperCase() !== (s.vendor ?? "");

// POS360 VENDORS: the vendor file. S shows one for update; PF5 adds one.

export const vendors = guarded("items", panel<VendorsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS360");
		header(scr, ctx, "VENDORS");
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE", { color: "blue" });
		const { vendors, total } = await listVendors(ctx.env.DB, s.top ?? 0, listRows(ctx));
		s.keys = vendors.map((v) => v.code);
		s.total = total;
		rowCount(scr, s.top ?? 0, vendors.length, total);
		scr.text(6, 2, "S CODE     NAME                           PHONE                LEAD  ST", { color: "white", bright: true });
		rule(scr, 7);
		if (total === 0) scr.text(FIRST, 4, "NO VENDORS YET - PF5 TO ADD ONE", { color: "blue" });
		vendors.forEach((v, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${v.code}`, "", { bright: s.errSel === `sel:${v.code}` });
			scr.text(row, 4, pad(v.code, 8), { color: "turquoise" });
			scr.text(row, 13, pad(v.name, 30), { color: "green" });
			scr.text(row, 44, pad(v.phone, 20), { color: "green" });
			scr.text(row, 65, lpad(v.leadDays, 4), { color: "green" });
			scr.text(row, 71, v.status, { color: v.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		if (vendors.length) scr.cursorTo(`sel:${vendors[0].code}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "vendor", back: s } satisfies VendorState;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "vendor", back: s, code: x.key } satisfies VendorState;
			s.msg = `${msgId(ctx, "3601E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS361 VENDOR: one vendor, to add or update.

const VENDOR_FIELDS = ["code", "name", "contact", "phone", "email", "terms", "leadDays", "status"] as const;

export const vendor = guarded("items", panel<VendorState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS361");
		const v = s.code ? await getVendor(ctx.env.DB, s.code) : undefined;
		header(scr, ctx, v ? `VENDOR ${v.code}` : "ADD VENDOR");
		if (s.code && !v) {
			message(scr, `${msgId(ctx, "3602E")} VENDOR ${s.code} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (v) s.version ??= v.version;
		form(scr, [
			{ row: 4, label: "CODE", name: "code", len: 8, value: v?.code ?? "", protect: !!v, note: v ? "" : "ON EACH OF THE VENDOR'S ITEMS" },
			{ row: 5, label: "NAME", name: "name", len: 30, value: v?.name ?? "" },
			{ row: 6, label: "CONTACT", name: "contact", len: 30, value: v?.contact ?? "" },
			{ row: 7, label: "PHONE", name: "phone", len: 20, value: v?.phone ?? "" },
			{ row: 8, label: "EMAIL", name: "email", len: 40, value: v?.email ?? "" },
			{ row: 9, label: "TERMS", name: "terms", len: 20, value: v?.terms ?? "", note: "E.G. NET 30" },
			{ row: 10, label: "LEAD TIME", name: "leadDays", len: 3, value: String(v?.leadDays ?? 7), numeric: true, note: "DAYS FROM ORDER TO DELIVERY" },
			{ row: 11, label: "STATUS", name: "status", len: 1, value: v?.status ?? "A", note: "A=ACTIVE  I=INACTIVE" },
		], s.errField);
		if (v) scr.text(13, 2, `LAST CHANGED ${clock(ctx, v.updatedAt)} BY ${v.updatedBy}   VERSION ${v.version}`, { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, `PF3=RETURN  ENTER=${v ? "UPDATE" : "ADD"}`);
		scr.cursorTo(s.errField ?? (v ? "name" : "code"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed: VendorInput = { ...pick(inp, VENDOR_FIELDS), ...(s.code ? { code: s.code } : {}) };
		try {
			const v = s.code ? await updateVendor(ctx.env.DB, ctx.user, s.version ?? 0, typed) : await addVendor(ctx.env.DB, ctx.user, typed);
			s.msg = `${msgId(ctx, s.code ? "3603I" : "3604I")} VENDOR ${v.code} ${s.code ? "UPDATED" : "ADDED"}`;
			s.code = v.code;
			s.version = v.version;
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "3605");
		}
	},
}));

// POS370 PURCHASE ORDERS: open POs first by default. S shows one; PF5
// starts one; PF6 shows all, closed ones too.

export const pos = guarded("purchasing", panel<PosState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS370");
		header(scr, ctx, s.all ? "PURCHASE ORDERS - ALL" : "PURCHASE ORDERS - OPEN");
		const w = (await who(ctx))!;
		scr.text(5, 2, "SELECT: S=SHOW/RECEIVE", { color: "blue" });
		scr.text(6, 2, "S    PO  VENDOR   STORE  EXPECTED          TOTAL  STATUS", { color: "white", bright: true });
		rule(scr, 7);
		const { pos, total } = await listPos(ctx.env.DB, w.stores, { open: !s.all, offset: s.top ?? 0, limit: listRows(ctx) });
		s.keys = pos.map((p) => String(p.id));
		s.total = total;
		rowCount(scr, s.top ?? 0, pos.length, total);
		if (total === 0) scr.text(FIRST, 4, `NO ${s.all ? "" : "OPEN "}PURCHASE ORDERS - PF5 TO START ONE`, { color: "blue" });
		pos.forEach((p, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${p.id}`, "", { bright: s.errSel === `sel:${p.id}` });
			scr.text(row, 4, lpad(p.id, 5), { color: "turquoise" });
			scr.text(row, 11, pad(p.vendor, 8), { color: "green" });
			scr.text(row, 20, lpad(p.store, 5), { color: "green" });
			scr.text(row, 27, pad(p.expected, 10), { color: "green" });
			scr.text(row, 38, lpad(dollars(p.total), 13), { color: "green" });
			scr.text(row, 53, PO_STATUS[p.status], { color: p.status === "R" || p.status === "X" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, `PF3=EXIT  PF5=START A PO  PF6=${s.all ? "OPEN ONLY" : "ALL"}  PF7=UP  PF8=DOWN`);
		if (pos.length) scr.cursorTo(s.errSel ?? `sel:${pos[0].id}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(5)) return { p: "po", back: s, token: crypto.randomUUID() } satisfies PoState;
		if (inp.aid === pf(6)) {
			s.all = !s.all;
			s.top = 0;
			return s;
		}
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "po", back: s, id: Number(x.key), token: crypto.randomUUID() } satisfies PoState;
			s.msg = `${msgId(ctx, "3701E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS371 PURCHASE ORDER. Starting one: vendor, store, expected date and up
// to twelve items (a blank cost takes the item's cost); Enter saves it as
// a draft. A draft: PF10 orders it, PF11 cancels it. An ordered PO: key
// what came in beside each line and press Enter to receive it; PF10
// receives what is keyed and closes the PO, nothing more to come.

const PO_LINES = 12;

export const po = guarded("purchasing", panel<PoState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS371");
		if (s.id === undefined) {
			header(scr, ctx, "START A PURCHASE ORDER");
			label(scr, 3, 2, "VENDOR ==>");
			scr.input(3, 13, 8, "vendor", "", { bright: s.errField === "vendor" });
			label(scr, 3, 23, "STORE ==>");
			scr.input(3, 33, 3, "store", await homeStore(ctx), { numeric: true, bright: s.errField === "store" });
			label(scr, 3, 38, "EXPECTED ==>");
			scr.input(3, 51, 10, "expected", "", { bright: s.errField === "expected" });
			scr.text(4, 51, "YYYY-MM-DD", { color: "blue" });
			scr.text(5, 2, "SKU               QTY        COST", { color: "white", bright: true });
			rule(scr, 6);
			for (let i = 0; i < PO_LINES; i++) {
				scr.input(7 + i, 2, 14, `sku:${i}`, "", { bright: s.errField === `sku:${i}` });
				scr.input(7 + i, 18, 9, `qty:${i}`, "", { bright: s.errField === `qty:${i}` });
				scr.input(7 + i, 29, 9, `cost:${i}`, "", { bright: s.errField === `cost:${i}` });
			}
			message(scr, s.msg ?? "");
			keys(scr, "PF3=RETURN  ENTER=SAVE AS A DRAFT");
			scr.cursorTo(s.errField ?? "vendor");
			return scr;
		}
		const p = await getPo(ctx.env.DB, s.id);
		header(scr, ctx, `PURCHASE ORDER ${s.id}`);
		if (!p) {
			message(scr, `${msgId(ctx, "3711E")} PURCHASE ORDER ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		const receiving = p.status === "O" || p.status === "P";
		scr.text(3, 2, `${p.vendor} ${p.vendorName}  STORE ${p.store}  ${PO_STATUS[p.status]}`, { color: "white", bright: true });
		scr.text(4, 2, `EXPECTED ${p.expected || "-"}  STARTED ${clock(ctx, p.createdAt)} BY ${p.createdBy}  TOTAL ${dollars(p.total)}`, { color: "turquoise" });
		scr.text(6, 2, "SKU            DESCRIPTION                 ORDERED     COST  RECEIVED    NOW", { color: "white", bright: true });
		rule(scr, 7);
		p.lines.slice(0, listRows(ctx)).forEach((l, i) => {
			const row = FIRST + i;
			scr.text(row, 2, pad(l.sku, 14), { color: "turquoise" });
			scr.text(row, 17, pad(l.desc, 26), { color: "green" });
			scr.text(row, 44, lpad(showQty(l.qty, l.weighed), 7), { color: "green" });
			scr.text(row, 52, lpad(dollars(l.cost), 8), { color: "green" });
			scr.text(row, 61, lpad(showQty(l.received, l.weighed), 9), { color: l.received >= l.qty ? "green" : "yellow" });
			if (receiving) scr.input(row, 72, 8, `r:${l.sku}`, "", { bright: s.errField === `r:${l.sku}` });
		});
		message(scr, s.msg ?? "");
		keys(scr, p.status === "D" ? "PF3=RETURN  PF10=ORDER  PF11=CANCEL"
			: receiving ? `PF3=RETURN  ENTER=RECEIVE  PF10=RECEIVE AND CLOSE${p.status === "O" ? "  PF11=CANCEL" : ""}` : "PF3=RETURN");
		if (receiving && p.lines.length) scr.cursorTo(s.errField ?? `r:${p.lines[0].sku}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (s.id === undefined) {
			if (inp.aid !== "ENTER") {
				s.msg = invalidKey(ctx, inp.aid);
				return s;
			}
			const vendor = (inp.fields.vendor ?? "").trim().toUpperCase();
			if (!vendor) return failAt(ctx, s, inp, "vendor", "3712E KEY THE VENDOR'S CODE");
			const store = await storeField(ctx, inp.fields.store ?? "");
			if (typeof store === "string") return failAt(ctx, s, inp, "store", `3713E ${store}`);
			try {
				const expected = readDate(inp.fields.expected ?? "", "expected");
				const lines = await readPoLines(ctx.env.DB, Array.from({ length: PO_LINES }, (_, i) => ({
					sku: inp.fields[`sku:${i}`] ?? "", qty: inp.fields[`qty:${i}`] ?? "", cost: inp.fields[`cost:${i}`] ?? "",
				})), vendor);
				s.id = await newPo(ctx.env.DB, ctx.user, vendor, store, expected, lines);
			} catch (e) {
				if (!(e instanceof Invalid)) throw e;
				return failAt(ctx, s, inp, e.field, `3714E ${e.message}`);
			}
			s.msg = `${msgId(ctx, "3715I")} PURCHASE ORDER ${s.id} SAVED AS A DRAFT - PF10 ORDERS IT`;
			return s;
		}
		const p = await getPo(ctx.env.DB, s.id);
		if (!p) return s.back;
		if (!canStore((await who(ctx))!, p.store)) {
			s.msg = `${msgId(ctx, "3716E")} YOU MAY NOT WORK ON STORE ${p.store}`;
			return s;
		}
		if (p.status === "D" && inp.aid === pf(10)) {
			await orderPo(ctx.env.DB, ctx.user, p.id);
			s.msg = `${msgId(ctx, "3717I")} PURCHASE ORDER ${p.id} ORDERED FROM ${p.vendor}`;
			return s;
		}
		if ((p.status === "D" || p.status === "O") && inp.aid === pf(11)) {
			await cancelPo(ctx.env.DB, ctx.user, p.id);
			s.msg = `${msgId(ctx, "3718I")} PURCHASE ORDER ${p.id} CANCELLED`;
			return s;
		}
		if ((p.status === "O" || p.status === "P") && (inp.aid === "ENTER" || inp.aid === pf(10))) {
			const got: [string, number][] = [];
			for (const l of p.lines) {
				const f = `r:${l.sku}`;
				const typed = (inp.fields[f] ?? "").trim();
				if (!typed || zero(typed)) continue;
				const q = readQty(typed, l.weighed);
				if (q === undefined) return failAt(ctx, s, inp, f, `3719E ${l.sku}: ${l.weighed ? "KEY THE POUNDS, E.G. 25.5" : "KEY A WHOLE NUMBER"}`);
				got.push([l.sku, q]);
			}
			try {
				const r = await receivePo(ctx.env.DB, ctx.user, p.id, s.token, got, inp.aid === pf(10));
				s.token = crypto.randomUUID();
				s.msg = r === "already" ? `${msgId(ctx, "3720W")} THAT DELIVERY WAS ALREADY RECEIVED`
					: `${msgId(ctx, "3721I")} ${got.length} LINE(S) RECEIVED - PO ${p.id} ${r === "received" ? "IS CLOSED" : "STAYS OPEN FOR THE REST"}`;
			} catch (e) {
				if (!(e instanceof Invalid)) throw e;
				s.msg = `${msgId(ctx, "3722E")} ${e.message}`;
			}
			return s;
		}
		if (inp.aid !== "ENTER") s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// POS372 SUGGESTED ORDER: what a store should order from a vendor, from
// reorder points or the last four weeks' sales. Change the quantities as
// wanted; PF10 makes a draft PO of them.

export const suggested = guarded("purchasing", panel<SuggestState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS372");
		header(scr, ctx, "SUGGESTED ORDER");
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : await homeStore(ctx), { numeric: true, bright: s.errField === "store" });
		label(scr, 3, 20, "VENDOR ===>");
		scr.input(3, 32, 8, "vendor", s.vendor ?? "", { bright: s.errField === "vendor" });
		scr.text(5, 2, "SKU            DESCRIPTION              ON HAND ORDERED  MIN/MAX  28 DAYS    ORDER", { color: "white", bright: true });
		rule(scr, 6);
		s.keys = [];
		if (s.store === undefined || !s.vendor) scr.text(7, 4, "KEY A STORE AND A VENDOR", { color: "blue" });
		else {
			const list = await suggest(ctx.env.DB, s.store, s.vendor, stamp(ctx, new Date().toISOString()).slice(0, 10));
			s.keys = list.map((x) => x.sku);
			if (list.length === 0) scr.text(7, 4, "NOTHING TO ORDER", { color: "blue" });
			list.slice(0, ctx.rows - 9).forEach((x, i) => {
				const row = 7 + i;
				const w = x.weighed;
				scr.text(row, 2, pad(x.sku, 14), { color: "turquoise" });
				scr.text(row, 17, pad(x.desc, 23), { color: "green" });
				scr.text(row, 41, lpad(showQty(x.onHand, w), 7), { color: "green" });
				scr.text(row, 49, lpad(showQty(x.onOrder, w), 7), { color: "green" });
				scr.text(row, 57, lpad(x.min !== null ? `${showQty(x.min, w)}/${showQty(x.max!, w)}` : "", 8), { color: "green" });
				scr.text(row, 66, lpad(showQty(x.sold, w), 7), { color: "green" });
				scr.input(row, 75, 5, `q:${x.sku}`, showQty(x.qty, w), { bright: s.errField === `q:${x.sku}` });
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  ENTER=SUGGEST  PF10=MAKE A DRAFT PO");
		scr.cursorTo(s.errField ?? (s.keys.length ? `q:${s.keys[0]}` : s.store ? "vendor" : "store"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER" && inp.aid !== pf(10)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		if (picked(inp, s) || s.store === undefined || !s.vendor) {
			const store = await storeField(ctx, inp.fields.store ?? "");
			if (typeof store === "string") return failAt(ctx, s, inp, "store", `3731E ${store}`);
			const v = await getVendor(ctx.env.DB, (inp.fields.vendor ?? "").trim().toUpperCase());
			if (!v) return failAt(ctx, s, inp, "vendor", `3732E VENDOR ${(inp.fields.vendor ?? "").trim().toUpperCase()} NOT FOUND`);
			s.store = store;
			s.vendor = v.code;
			return s;
		}
		if (inp.aid !== pf(10)) return s;
		const lines: { sku: string; qty: string; cost: string }[] = [];
		for (const sku of s.keys ?? []) {
			const typed = (inp.fields[`q:${sku}`] ?? "").trim();
			if (typed && !zero(typed)) lines.push({ sku, qty: typed, cost: "" });
		}
		try {
			const id = await newPo(ctx.env.DB, ctx.user, s.vendor, s.store, "", await readPoLines(ctx.env.DB, lines, s.vendor));
			return { p: "po", back: s.back, id, token: crypto.randomUUID(), msg: `${msgId(ctx, "3733I")} PURCHASE ORDER ${id} SAVED AS A DRAFT - PF10 ORDERS IT` } satisfies PoState;
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			const sku = lines[Number(e.field.split(":")[1])]?.sku;
			return failAt(ctx, s, inp, sku ? `q:${sku}` : "vendor", `3734E ${e.message}`);
		}
	},
}));

// POS373 REORDER POINTS: each item's min and max at a store, for suggested
// orders. Blank both to clear them.

export const reorder = guarded("purchasing", panel<ReorderState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS373");
		header(scr, ctx, "REORDER POINTS");
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : await homeStore(ctx), { numeric: true, bright: s.errField === "store" });
		label(scr, 3, 20, "VENDOR ===>");
		scr.input(3, 32, 8, "vendor", s.vendor ?? "", { bright: s.errField === "vendor" });
		scr.text(3, 42, "BLANK FOR EVERY VENDOR", { color: "blue" });
		scr.text(6, 2, "SKU            DESCRIPTION                          ON HAND      MIN      MAX", { color: "white", bright: true });
		rule(scr, 7);
		s.keys = [];
		if (s.store === undefined) scr.text(FIRST, 4, "KEY A STORE", { color: "blue" });
		else {
			const { lines, total } = await reorderPoints(ctx.env.DB, s.store, { vendor: s.vendor, offset: s.top ?? 0, limit: listRows(ctx) });
			s.keys = lines.map((l) => l.sku);
			s.total = total;
			rowCount(scr, s.top ?? 0, lines.length, total);
			lines.forEach((l, i) => {
				const row = FIRST + i;
				scr.text(row, 2, pad(l.sku, 14), { color: "turquoise" });
				scr.text(row, 17, pad(l.desc, 35), { color: "green" });
				scr.text(row, 53, lpad(showQty(l.onHand, l.weighed), 8), { color: "green" });
				scr.input(row, 64, 7, `min:${l.sku}`, l.min === null ? "" : showQty(l.min, l.weighed), { bright: s.errField === `min:${l.sku}` });
				scr.input(row, 73, 7, `max:${l.sku}`, l.max === null ? "" : showQty(l.max, l.weighed), { bright: s.errField === `max:${l.sku}` });
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF7=UP  PF8=DOWN  ENTER=SAVE");
		scr.cursorTo(s.errField ?? (s.keys.length ? `min:${s.keys[0]}` : "store"));
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
		if (picked(inp, s) || s.store === undefined) {
			const store = await storeField(ctx, inp.fields.store ?? "");
			if (typeof store === "string") return failAt(ctx, s, inp, "store", `3741E ${store}`);
			const code = (inp.fields.vendor ?? "").trim().toUpperCase();
			if (code && !(await getVendor(ctx.env.DB, code))) return failAt(ctx, s, inp, "vendor", `3742E VENDOR ${code} NOT FOUND`);
			s.store = store;
			s.vendor = code || undefined;
			s.top = 0;
			return s;
		}
		const shown = (await reorderPoints(ctx.env.DB, s.store, { vendor: s.vendor, offset: s.top ?? 0, limit: listRows(ctx) })).lines;
		const changes: [string, number | null, number | null][] = [];
		for (const l of shown) {
			if (!inp.modified.has(`min:${l.sku}`) && !inp.modified.has(`max:${l.sku}`)) continue;
			const read = (f: string) => {
				const t = (inp.fields[`${f}:${l.sku}`] ?? "").trim();
				return t === "" ? null : zero(t) ? 0 : readQty(t, l.weighed);
			};
			const min = read("min");
			const max = read("max");
			if (min === undefined) return failAt(ctx, s, inp, `min:${l.sku}`, `3743E ${l.sku}: MIN IS A QUANTITY, OR BLANK`);
			if (max === undefined) return failAt(ctx, s, inp, `max:${l.sku}`, `3743E ${l.sku}: MAX IS A QUANTITY, OR BLANK`);
			changes.push([l.sku, min, max]);
		}
		try {
			for (const [sku, min, max] of changes) await setReorder(ctx.env.DB, ctx.user, s.store, sku, min, max);
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			return failAt(ctx, s, inp, e.field, `3744E ${e.message}`);
		}
		if (changes.length) s.msg = `${msgId(ctx, "3745I")} ${changes.length} REORDER POINT(S) SAVED FOR STORE ${s.store}`;
		return s;
	},
}));

// POS380 RETURN TO VENDOR: stock sent back, off on hand at once.

const RET_LINES = 10;

export const vendorReturn = guarded("purchasing", panel<VendorReturnState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS380");
		header(scr, ctx, "RETURN TO VENDOR");
		label(scr, 3, 2, "VENDOR ==>");
		scr.input(3, 13, 8, "vendor", "", { bright: s.errField === "vendor" });
		label(scr, 3, 23, "STORE ==>");
		scr.input(3, 33, 3, "store", await homeStore(ctx), { numeric: true, bright: s.errField === "store" });
		label(scr, 4, 2, "REASON ==>");
		scr.input(4, 13, 30, "reason", "", { bright: s.errField === "reason" });
		scr.text(6, 2, "SKU               QTY        COST", { color: "white", bright: true });
		rule(scr, 7);
		for (let i = 0; i < RET_LINES; i++) {
			scr.input(8 + i, 2, 14, `sku:${i}`, "", { bright: s.errField === `sku:${i}` });
			scr.input(8 + i, 18, 9, `qty:${i}`, "", { bright: s.errField === `qty:${i}` });
			scr.input(8 + i, 29, 9, `cost:${i}`, "", { bright: s.errField === `cost:${i}` });
		}
		scr.text(8, 40, "A BLANK COST TAKES THE ITEM'S COST", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  ENTER=SEND BACK");
		scr.cursorTo(s.errField ?? "vendor");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const vendor = (inp.fields.vendor ?? "").trim().toUpperCase();
		if (!vendor) return failAt(ctx, s, inp, "vendor", "3801E KEY THE VENDOR'S CODE");
		const store = await storeField(ctx, inp.fields.store ?? "");
		if (typeof store === "string") return failAt(ctx, s, inp, "store", `3802E ${store}`);
		try {
			const lines = await readPoLines(ctx.env.DB, Array.from({ length: RET_LINES }, (_, i) => ({
				sku: inp.fields[`sku:${i}`] ?? "", qty: inp.fields[`qty:${i}`] ?? "", cost: inp.fields[`cost:${i}`] ?? "",
			})), vendor);
			const id = await returnToVendor(ctx.env.DB, ctx.user, s.token, vendor, store, inp.fields.reason ?? "", lines);
			const total = lines.reduce((t, l) => t + lineCost(l.qty, l.cost), 0);
			return { ...s, token: crypto.randomUUID(), msg: `${msgId(ctx, "3803I")} RETURN ${id} TO ${vendor}: ${lines.length} ITEM(S), ${dollars(total)} AT COST` };
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			return failAt(ctx, s, inp, e.field, `3804E ${e.message}`);
		}
	},
}));
