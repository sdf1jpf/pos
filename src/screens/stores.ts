import { clock, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, withFill } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { Invalid } from "../data/db";
import { addRegister, addStore, getStore, listRegisters, listStores, storeNumber, updateRegister, updateStore, type StoreInput } from "../data/stores";
import type { Env } from "../env";
import { rate } from "../money";
import { FIRST, form, guarded, listRows, pick, refused, rowCount, rule, scroll, selected } from "./common";
import type { RegistersState, StoresState, StoreState } from "./types";

// POS810 STORES: every store. S beside one shows it for update, R lists
// its registers; PF5 adds a store.

export const stores = guarded("stores", panel<StoresState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS810");
		header(scr, ctx, "STORES");
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE  R=REGISTERS", { color: "blue" });
		const all = await listStores(ctx.env.DB);
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(all.length - rows, 0));
		const shown = all.slice(top, top + rows);
		s.top = top;
		s.total = all.length;
		s.keys = shown.map((x) => String(x.store));
		if (all.length > 0) rowCount(scr, top, shown.length, all.length);
		scr.text(6, 2, "S STORE  NAME                           CITY                 ST    TAX  STAT", { color: "white", bright: true });
		rule(scr, 7);
		if (all.length === 0) scr.text(FIRST, 4, "NO STORES YET - PF5 TO ADD ONE", { color: "blue" });
		shown.forEach((x, i) => {
			const row = FIRST + i;
			const sel = `sel:${x.store}`;
			scr.input(row, 2, 1, sel, "", { bright: s.errSel === sel });
			scr.text(row, 4, lpad(String(x.store).padStart(3, "0"), 5), { color: "turquoise" });
			scr.text(row, 11, pad(x.name, 30), { color: "green" });
			scr.text(row, 42, pad(x.city, 20), { color: "green" });
			scr.text(row, 63, pad(x.state, 2), { color: "green" });
			scr.text(row, 66, lpad(rate(x.taxRate), 6), { color: "green" });
			scr.text(row, 74, x.status, { color: x.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		if (shown.length > 0) scr.cursorTo(`sel:${shown[0].store}`);
		else scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		switch (inp.aid) {
			case "ENTER":
				break;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				return { p: "store", back: s } satisfies StoreState;
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "store", back: s, store: Number(x.key) } satisfies StoreState;
			if (x.code === "R") return { p: "registers", back: s, store: Number(x.key) } satisfies RegistersState;
			s.msg = `${msgId(ctx, "0801E")} INVALID SELECTION CODE "${x.code}" - TYPE S OR R`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS811 STORE: one store, to add or update.

const FIELDS = ["store", "name", "addr1", "addr2", "city", "state", "zip", "phone", "taxRate", "discountLimit",
	"header1", "header2", "footer1", "footer2", "status"] as const;

export const store = guarded("stores", panel<StoreState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS811");
		const st = s.store !== undefined ? await getStore(ctx.env.DB, s.store) : undefined;
		header(scr, ctx, st ? `STORE ${String(st.store).padStart(3, "0")}` : "ADD STORE");
		if (s.store !== undefined && !st) {
			message(scr, `${msgId(ctx, "0802E")} STORE ${s.store} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (st) s.version ??= st.version;
		form(scr, [
			{ row: 4, label: "STORE NUMBER", name: "store", len: 3, value: st ? String(st.store) : "", protect: !!st, numeric: true, note: st ? "" : "1 TO 999" },
			{ row: 5, label: "NAME", name: "name", len: 30, value: st?.name ?? "" },
			{ row: 6, label: "ADDRESS", name: "addr1", len: 30, value: st?.addr1 ?? "" },
			{ row: 7, label: "", name: "addr2", len: 30, value: st?.addr2 ?? "" },
			{ row: 8, label: "CITY", name: "city", len: 20, value: st?.city ?? "" },
			{ row: 9, label: "STATE", name: "state", len: 2, value: st?.state ?? "" },
			{ row: 9, label: "ZIP", name: "zip", len: 10, value: st?.zip ?? "", col: 30 },
			{ row: 10, label: "PHONE", name: "phone", len: 14, value: st?.phone ?? "" },
			{ row: 12, label: "SALES TAX RATE", name: "taxRate", len: 7, value: st ? rate(st.taxRate) : "", note: "PERCENT, E.G. 8.25" },
			{ row: 13, label: "DISCOUNT LIMIT", name: "discountLimit", len: 3, value: st ? String(st.discountLimit) : "10", numeric: true, note: "PERCENT A CASHIER MAY GIVE WITHOUT A MANAGER" },
			{ row: 14, label: "STATUS", name: "status", len: 1, value: st?.status ?? "A", note: "A=ACTIVE  I=INACTIVE" },
			{ row: 16, label: "RECEIPT HEADER", name: "header1", len: 38, value: st?.header1 ?? "" },
			{ row: 17, label: "", name: "header2", len: 38, value: st?.header2 ?? "" },
			{ row: 18, label: "RECEIPT FOOTER", name: "footer1", len: 38, value: st?.footer1 ?? "" },
			{ row: 19, label: "", name: "footer2", len: 38, value: st?.footer2 ?? "" },
		], s.errField);
		if (st) scr.text(21, 2, `LAST CHANGED ${clock(ctx, st.updatedAt)} BY ${st.updatedBy}   VERSION ${st.version}`, { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, `PF3=RETURN  ENTER=${st ? "UPDATE" : "ADD"}`);
		scr.cursorTo(s.errField ?? (st ? "name" : "store"));
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed: StoreInput = { ...pick(inp, FIELDS), ...(s.store !== undefined ? { store: String(s.store) } : {}) };
		try {
			if (s.store !== undefined) {
				const st = await updateStore(ctx.env.DB, ctx.user, s.version ?? 0, typed);
				s.version = st.version;
				s.msg = `${msgId(ctx, "0803I")} STORE ${st.store} UPDATED`;
			} else {
				const st = await addStore(ctx.env.DB, ctx.user, typed);
				s.store = st.store;
				s.version = st.version;
				s.msg = `${msgId(ctx, "0804I")} STORE ${st.store} ADDED - R ON THE STORE LIST ADDS ITS REGISTERS`;
			}
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "0805");
		}
	},
}));

// POS820 REGISTERS: a store's registers, changed in place; the top line
// adds one.

export const registers = guarded("stores", panel<RegistersState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS820");
		header(scr, ctx, "REGISTERS");
		const st = s.store !== undefined ? await getStore(ctx.env.DB, s.store) : undefined;
		label(scr, 4, 2, "STORE ===>");
		scr.input(4, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		scr.text(4, 18, pad(st?.name ?? "", 30), { color: "white" });
		s.keys = [];
		if (st) {
			label(scr, 5, 2, "ADD: REG ===>");
			scr.input(5, 16, 2, "reg", "", { numeric: true, bright: s.errField === "reg" });
			label(scr, 5, 20, "NAME ===>");
			scr.input(5, 30, 20, "name", "", { bright: s.errField === "name" });
			scr.text(6, 2, "REG  NAME                  ST  SERVICE TOKEN CLIENT ID (ENROLLED REGISTER)", { color: "white", bright: true });
			rule(scr, 7);
			const regs = await listRegisters(ctx.env.DB, st.store);
			const rows = listRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(regs.length - rows, 0));
			const shown = regs.slice(top, top + rows);
			s.top = top;
			s.total = regs.length;
			s.keys = shown.map((r) => String(r.reg));
			if (regs.length > 0) rowCount(scr, top, shown.length, regs.length);
			if (regs.length === 0) scr.text(FIRST, 2, "NO REGISTERS YET - ADD ONE ON THE LINE ABOVE", { color: "blue" });
			shown.forEach((r, i) => {
				const row = FIRST + i;
				scr.text(row, 2, String(r.reg).padStart(2, "0"), { color: "turquoise" });
				scr.input(row, 7, 20, `name:${r.reg}`, r.name, { bright: s.errField === `name:${r.reg}` });
				scr.input(row, 29, 1, `st:${r.reg}`, r.status, { bright: s.errField === `st:${r.reg}` });
				scr.input(row, 33, 39, `tok:${r.reg}`, r.token, { bright: s.errField === `tok:${r.reg}` });
			});
		} else {
			scr.text(FIRST, 2, "ENTER A STORE NUMBER TO SEE ITS REGISTERS", { color: "blue" });
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF7=UP  PF8=DOWN  ENTER=SAVE");
		scr.cursorTo(s.errField ?? (st ? "reg" : "store"));
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
		if (inp.modified.has("store") || s.store === undefined) {
			const typed = (inp.fields.store ?? "").trim();
			if (!typed) return s;
			const n = storeNumber(typed);
			const msg = n === undefined ? "0806E STORE MUST BE 1 TO 999"
				: !(await getStore(ctx.env.DB, n)) ? `0807E STORE ${n} NOT FOUND`
				: !canStore(w, n) ? `0808E YOU MAY NOT CHANGE STORE ${n}` : undefined;
			if (msg) {
				s.msg = msgId(ctx, msg);
				s.errField = "store";
				return withFill(s, { fields: { store: typed }, cursor: "store" });
			}
			s.store = n;
			s.top = 0;
			return s;
		}
		const store = s.store;
		let saved = 0;
		try {
			if ((inp.fields.reg ?? "").trim()) {
				await addRegister(ctx.env.DB, ctx.user, store, inp.fields.reg, inp.fields.name ?? "");
				for (const f of ["reg", "name"]) delete inp.fields[f];
				saved++;
			}
			for (const key of s.keys ?? []) {
				if (!["name", "st", "tok"].some((f) => inp.modified.has(`${f}:${key}`))) continue;
				try {
					await updateRegister(ctx.env.DB, ctx.user, store, Number(key), inp.fields[`name:${key}`] ?? "", inp.fields[`st:${key}`] ?? "", inp.fields[`tok:${key}`] ?? "");
				} catch (e) {
					if (e instanceof Invalid) throw new Invalid(`${e.field === "status" ? "st" : e.field === "token" ? "tok" : "name"}:${key}`, `REGISTER ${key}: ${e.message}`);
					throw e;
				}
				saved++;
			}
		} catch (e) {
			return refused(ctx, s, inp, e, "0809");
		}
		if (saved > 0) s.msg = `${msgId(ctx, "0810I")} ${saved} REGISTER(S) SAVED FOR STORE ${store}`;
		return s;
	},
}));
