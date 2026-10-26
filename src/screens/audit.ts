import { clock, header, invalidKey, keys, label, message, msgId, newScreen, pad, panel, pf, stamp, withFill } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { getAudit, listAudit } from "../data/auditlog";
import { Invalid } from "../data/db";
import { isKind, KINDS, listReasons, saveReason, type Kind } from "../data/reasons";
import { getStore, storeNumber } from "../data/stores";
import { addDays, utcOf, validDay } from "../data/timeclock";
import type { Env } from "../env";
import { FIRST, guarded, listRows, rowCount, rule, scroll, selected } from "./common";
import type { AuditRowState, AuditState, ReasonsState } from "./types";

// The audit log (8.3) and reason codes (8.4). Maps are POS830 to POS840.

// POS830 AUDIT LOG: every change, newest first, narrowed by store, userid,
// the start of the action and a date. Managers see only their stores'.

export const audit = guarded("audit", panel<AuditState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS830");
		header(scr, ctx, "AUDIT LOG");
		const w = (await who(ctx))!;
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		label(scr, 3, 18, "USER ===>");
		scr.input(3, 28, 8, "userid", s.userid ?? "", { bright: s.errField === "userid" });
		label(scr, 3, 38, "ACTION ===>");
		scr.input(3, 50, 12, "action", s.action ?? "", { bright: s.errField === "action" });
		label(scr, 4, 2, "ON OR BEFORE ===>");
		scr.input(4, 20, 10, "before", s.before ?? "", { bright: s.errField === "before" });
		scr.text(4, 32, "YYYY-MM-DD", { color: "blue" });
		scr.text(5, 2, "SELECT: S=SHOW   ACTION IS ITS START, E.G. TIME OR SALE.VOID", { color: "blue" });
		scr.text(6, 2, "S WHEN           USERID   STR RG ACTION         SUBJECT      DETAIL", { color: "white", bright: true });
		rule(scr, 7);
		const { rows, total } = await listAudit(ctx.env.DB, {
			store: s.store, stores: w.stores, userid: s.userid, action: s.action,
			before: s.before ? utcOf(`${addDays(s.before, 1)} 00:00`, ctx.tzOffset) : undefined,
		}, s.top ?? 0, listRows(ctx));
		s.keys = rows.map((r) => String(r.id));
		s.total = total;
		rowCount(scr, s.top ?? 0, rows.length, total, 4);
		if (total === 0) scr.text(FIRST, 4, "NOTHING MATCHES", { color: "blue" });
		rows.forEach((r, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${r.id}`, "");
			scr.text(row, 4, clock(ctx, r.at), { color: "turquoise" });
			scr.text(row, 19, pad(r.userid, 8), { color: "green" });
			scr.text(row, 28, r.store === null ? "   " : String(r.store).padStart(3), { color: "green" });
			scr.text(row, 32, r.reg === null ? "  " : String(r.reg).padStart(2, "0"), { color: "green" });
			scr.text(row, 35, pad(r.action, 14), { color: "white" });
			scr.text(row, 50, pad(r.subject, 12), { color: "green" });
			scr.text(row, 63, pad(r.detail, scr.cols - 63), { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? (rows.length ? `sel:${rows[0].id}` : "store"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, m: string) => {
			s.msg = `${msgId(ctx, "8301E")} ${m}`;
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const typed = {
			store: (inp.fields.store ?? "").trim(),
			userid: (inp.fields.userid ?? "").trim().toUpperCase(),
			action: (inp.fields.action ?? "").trim().toUpperCase(),
			before: (inp.fields.before ?? "").trim(),
		};
		let store: number | undefined;
		if (typed.store) {
			store = storeNumber(typed.store);
			if (store === undefined) return fail("store", "STORE MUST BE 1 TO 999");
			if (!(await getStore(ctx.env.DB, store))) return fail("store", `STORE ${store} NOT FOUND`);
			if (!canStore((await who(ctx))!, store)) return fail("store", `YOU MAY NOT WORK ON STORE ${store}`);
		}
		if (typed.before && !validDay(typed.before)) return fail("before", "THE DATE IS YYYY-MM-DD");
		const next = { store, userid: typed.userid || undefined, action: typed.action || undefined, before: typed.before || undefined };
		if (next.store !== s.store || next.userid !== s.userid || next.action !== s.action || next.before !== s.before) {
			Object.assign(s, next, { top: 0 });
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "auditrow", back: s, id: Number(x.key) } satisfies AuditRowState;
			s.msg = `${msgId(ctx, "8302E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS831 AUDIT ENTRY: one row of the log, its detail in full.

export const auditRow = guarded("audit", panel<AuditRowState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS831");
		header(scr, ctx, `AUDIT ENTRY ${s.id}`);
		const r = await getAudit(ctx.env.DB, s.id);
		const w = (await who(ctx))!;
		if (!r || (w.stores.length && (r.store === null || !canStore(w, r.store)))) {
			message(scr, `${msgId(ctx, "8311E")} AUDIT ENTRY ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		const line = (row: number, l: string, v: string) => {
			label(scr, row, 2, l.padEnd(10, "."));
			scr.text(row, 14, v, { color: "white" });
		};
		line(4, "WHEN", `${stamp(ctx, r.at)}  (${r.at} UTC)`);
		line(5, "USERID", r.userid);
		line(6, "STORE", r.store === null ? "" : String(r.store));
		line(7, "REGISTER", r.reg === null ? "" : String(r.reg));
		line(8, "ACTION", r.action);
		line(9, "SUBJECT", r.subject);
		line(10, "APPROVER", r.approver ?? "");
		label(scr, 12, 2, "DETAIL....");
		const width = scr.cols - 15;
		const text = r.detail || "(NONE)";
		for (let i = 0, row = 12; i < text.length && row < scr.rows - 1; i += width, row++) scr.text(row, 14, text.slice(i, i + width), { color: "green" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},
	handle(ctx, s, inp) {
		if (inp.aid === pf(3) || inp.aid === pf(12) || inp.aid === "ENTER") return s.back;
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// POS840 REASON CODES: the codes of a kind, changed in place; the last line
// adds one. A code is never deleted, only made inactive, so the records
// that name it still read.

export const reasonCodes = guarded("stores", panel<ReasonsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS840");
		header(scr, ctx, "REASON CODES");
		label(scr, 3, 2, "KIND ===>");
		scr.input(3, 12, 8, "kind", s.kind, { bright: s.errField === "kind" });
		scr.text(3, 22, Object.entries(KINDS).map(([k, v]) => `${k}=${v}`).join("  ").slice(0, scr.cols - 23), { color: "blue" });
		scr.text(5, 2, "CHANGE A DESCRIPTION OR STATUS (A OR I) IN PLACE; THE LAST LINE ADDS A CODE", { color: "blue" });
		scr.text(6, 2, "CODE  DESCRIPTION                     ST  CHANGED         BY", { color: "white", bright: true });
		rule(scr, 7);
		const list = isKind(s.kind) ? await listReasons(ctx.env.DB, s.kind) : [];
		const shown = list.slice(0, listRows(ctx) - 1);
		s.keys = shown.map((r) => r.code);
		shown.forEach((r, i) => {
			const row = FIRST + i;
			scr.text(row, 2, pad(r.code, 4), { color: "turquoise" });
			scr.input(row, 8, 30, `desc:${r.code}`, r.description, { bright: s.errField === `desc:${r.code}` });
			scr.input(row, 40, 1, `status:${r.code}`, r.status, { bright: s.errField === `status:${r.code}` });
			scr.text(row, 44, `${clock(ctx, r.updatedAt).slice(0, 11)}     ${r.updatedBy}`, { color: "green" });
		});
		const add = FIRST + shown.length;
		scr.input(add, 2, 2, "code:new", "", { bright: s.errField === "code:new" });
		scr.input(add, 8, 30, "desc:new", "", { bright: s.errField === "desc:new" });
		scr.text(add, 40, "ADD A CODE", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  ENTER=SAVE");
		scr.cursorTo(s.errField ?? (s.keys.length ? `desc:${s.keys[0]}` : "code:new"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const kind = (inp.fields.kind ?? "").trim().toUpperCase();
		if (!isKind(kind)) {
			s.msg = `${msgId(ctx, "8401E")} KIND IS ${Object.keys(KINDS).join(", ")}`;
			s.errField = "kind";
			return withFill(s, { fields: inp.fields, cursor: "kind" });
		}
		if (kind !== s.kind) {
			s.kind = kind;
			return s;
		}
		const k: Kind = kind;
		const now = await listReasons(ctx.env.DB, k);
		let done = 0;
		try {
			for (const code of s.keys ?? []) {
				const r = now.find((x) => x.code === code);
				const desc = inp.fields[`desc:${code}`];
				const status = inp.fields[`status:${code}`];
				if (!r || desc === undefined || status === undefined) continue;
				if (desc.trim().toUpperCase() === r.description && status.trim().toUpperCase() === r.status) continue;
				await saveReason(ctx.env.DB, ctx.user, k, code, desc, status, { code: `desc:${code}`, desc: `desc:${code}`, status: `status:${code}` });
				done++;
			}
			const code = (inp.fields["code:new"] ?? "").trim().toUpperCase();
			const desc = inp.fields["desc:new"] ?? "";
			if (code || desc.trim()) {
				if (now.some((x) => x.code === code)) throw new Invalid("code:new", `${code} IS ALREADY A CODE - CHANGE IT ABOVE`);
				await saveReason(ctx.env.DB, ctx.user, k, code, desc, "A", { code: "code:new", desc: "desc:new", status: "code:new" });
				done++;
			}
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			s.msg = `${msgId(ctx, "8402E")} ${e.message}`;
			s.errField = e.field;
			return withFill(s, { fields: inp.fields, cursor: e.field });
		}
		if (done) s.msg = `${msgId(ctx, "8403I")} ${done} CODE(S) SAVED`;
		return s;
	},
}));
