import { clock, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { addItem, getItem, listDepartments, searchItems, updateItem, type ItemInput } from "../data/items";
import type { Env } from "../env";
import { dollars } from "../money";
import { FIRST, form, guarded, listRows, pick, refused, rowCount, rule, scroll, selected, yn } from "./common";
import type { ItemsState, ItemState } from "./types";

// POS110 ITEM LIST: the item master by SKU, searched by SKU, UPC or words
// in the description, and by department. S beside an item shows it for
// update; PF5 adds one.

export const items = guarded("items", panel<ItemsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS110");
		header(scr, ctx, "ITEM LIST");
		label(scr, 4, 2, "SEARCH ===>");
		scr.input(4, 14, 20, "q", s.q ?? "", { bright: s.errField === "q" });
		label(scr, 4, 36, "DEPT ===>");
		scr.input(4, 46, 3, "dept", s.dept ? String(s.dept) : "", { numeric: true, bright: s.errField === "dept" });
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE", { color: "blue" });

		const rows = listRows(ctx);
		const { items, total } = await searchItems(ctx.env.DB, { q: s.q, dept: s.dept, offset: s.top ?? 0, limit: rows });
		s.keys = items.map((i) => i.sku);
		s.total = total;
		rowCount(scr, s.top ?? 0, items.length, total);
		scr.text(6, 2, "S SKU            DESCRIPTION                    DEPT      PRICE TX WT ST", { color: "white", bright: true });
		rule(scr, 7);
		if (total === 0) scr.text(FIRST, 4, s.q || s.dept ? "NO ITEMS MATCH - CHANGE THE SEARCH, OR PF5 TO ADD ONE" : "NO ITEMS YET - PF5 TO ADD ONE", { color: "blue" });
		items.forEach((it, i) => {
			const row = FIRST + i;
			const sel = `sel:${it.sku}`;
			scr.input(row, 2, 1, sel, "", { bright: s.errSel === sel });
			scr.text(row, 4, pad(it.sku, 14), { color: "turquoise" });
			scr.text(row, 19, pad(it.desc, 30), { color: "green" });
			scr.text(row, 50, lpad(it.dept, 4), { color: "green" });
			scr.text(row, 55, lpad(dollars(it.price), 10), { color: "green" });
			scr.text(row, 67, `${yn(it.taxable)}  ${yn(it.weighed)}  ${it.status}`, { color: it.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? (items.length > 0 ? `sel:${items[0].sku}` : "q"));
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errSel = s.errField = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		switch (inp.aid) {
			case "ENTER":
				break;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				return { p: "item", back: s } satisfies ItemState;
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}
		// A changed search starts the list again from the top.
		if (inp.modified.has("q") || inp.modified.has("dept")) {
			const dept = (inp.fields.dept ?? "").trim();
			if (dept && !/^\d{1,3}$/.test(dept)) {
				s.msg = `${msgId(ctx, "0101E")} DEPARTMENT MUST BE A NUMBER`;
				s.errField = "dept";
				return withFill(s, { fields: { dept }, cursor: "dept" });
			}
			s.q = (inp.fields.q ?? "").trim().toUpperCase();
			s.dept = dept ? Number(dept) : undefined;
			s.top = 0;
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code !== "S") {
				s.msg = `${msgId(ctx, "0102E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
				s.errSel = x.field;
				return s;
			}
			return { p: "item", back: s, sku: x.key } satisfies ItemState;
		}
		return s;
	},
}));

// POS111 ITEM: one item, to add or update. PF1 in DEPARTMENT lists them.

const FIELDS = ["sku", "upc", "desc", "dept", "class", "vendor", "cost", "price", "taxable", "weighed", "status"] as const;

export const item = guarded("items", panel<ItemState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS111");
		const it = s.sku ? await getItem(ctx.env.DB, s.sku) : undefined;
		header(scr, ctx, it ? `ITEM ${it.sku}` : "ADD ITEM");
		if (s.sku && !it) {
			message(scr, `${msgId(ctx, "0103E")} SKU ${s.sku} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (it) s.version ??= it.version;
		const depts = await listDepartments(ctx.env.DB);
		const deptName = depts.find((d) => d.dept === it?.dept)?.name ?? "";
		form(scr, [
			{ row: 4, label: "SKU", name: "sku", len: 14, value: it?.sku ?? "", protect: !!it },
			{ row: 5, label: "UPC", name: "upc", len: 14, value: it?.upc ?? "", numeric: true, note: "8 TO 14 DIGITS, OR BLANK" },
			{ row: 6, label: "DESCRIPTION", name: "desc", len: 30, value: it?.desc ?? "" },
			{ row: 7, label: "DEPARTMENT", name: "dept", len: 3, value: it ? String(it.dept) : "", numeric: true, note: deptName },
			{ row: 8, label: "CLASS", name: "class", len: 4, value: it?.class ?? "" },
			{ row: 9, label: "VENDOR", name: "vendor", len: 8, value: it?.vendor ?? "" },
			{ row: 11, label: "COST", name: "cost", len: 9, value: it ? dollars(it.cost) : "" },
			{ row: 12, label: "BASE PRICE", name: "price", len: 9, value: it ? dollars(it.price) : "", note: "PER LB FOR A WEIGHED ITEM" },
			{ row: 13, label: "TAXABLE", name: "taxable", len: 1, value: it ? yn(it.taxable) : "", note: "Y OR N; BLANK TAKES THE DEPARTMENT'S" },
			{ row: 14, label: "WEIGHED", name: "weighed", len: 1, value: it ? yn(it.weighed) : "N", note: "Y: SOLD BY THE POUND" },
			{ row: 15, label: "STATUS", name: "status", len: 1, value: it?.status ?? "A", note: "A=ACTIVE  D=DISCONTINUED" },
		], s.errField);
		if (it) {
			const margin = it.price > 0 ? Math.round(((it.price - it.cost) / it.price) * 1000) / 10 : 0;
			scr.text(11, 32, `MARGIN ${margin.toFixed(1)}%`, { color: "blue" });
			scr.text(17, 2, `LAST CHANGED ${clock(ctx, it.updatedAt)} BY ${it.updatedBy}   VERSION ${it.version}`, { color: "blue" });
		}
		message(scr, s.msg ?? "");
		keys(scr, `PF1=HELP  PF3=RETURN  ENTER=${it ? "UPDATE" : "ADD"}`);
		scr.cursorTo(s.errField ?? (it ? "upc" : "sku"));
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed: ItemInput = { ...pick(inp, FIELDS), ...(s.sku ? { sku: s.sku } : {}) };
		try {
			if (s.sku) {
				const it = await updateItem(ctx.env.DB, ctx.user, s.version ?? 0, typed);
				s.version = it.version;
				s.msg = `${msgId(ctx, "0104I")} ITEM ${it.sku} UPDATED`;
			} else {
				const it = await addItem(ctx.env.DB, ctx.user, typed);
				s.sku = it.sku;
				s.version = it.version;
				s.msg = `${msgId(ctx, "0105I")} ITEM ${it.sku} ADDED`;
			}
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "0106");
		}
	},
}));
