import { header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, stamp, withFill, type PanelState, type Screen } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { Invalid } from "../data/db";
import { getEmployee } from "../data/employees";
import { getStore, storeNumber } from "../data/stores";
import {
	addDays, copyWeek, deletePunch, hours, localDay, minutesBetween, monday, readShift, readTime, roster, savePunch, saveShifts,
	shiftMinutes, showShift, timeCard, timeCards, validDay, type Shift,
} from "../data/timeclock";
import type { Env } from "../env";
import { FIRST, guarded, listRows, rowCount, rule, scroll, selected } from "./common";
import type { PosCtx, ScheduleState, TimeCardsState, TimeCardState } from "./types";

// Time cards and the schedule, under menu 4. Maps are POS420 to POS430.

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const OVERTIME = 40 * 60; // minutes in a week

const today = (ctx: PosCtx) => localDay(new Date().toISOString(), ctx.tzOffset);
const md = (day: string) => `${day.slice(5, 7)}/${day.slice(8, 10)}`;
const hrs = (m: number) => (m ? hours(m) : "");

async function storeField(ctx: PosCtx, typed: string): Promise<number | string> {
	const n = storeNumber(typed);
	if (n === undefined) return "STORE MUST BE 1 TO 999";
	if (!(await getStore(ctx.env.DB, n))) return `STORE ${n} NOT FOUND`;
	if (!canStore((await who(ctx))!, n)) return `YOU MAY NOT WORK ON STORE ${n}`;
	return n;
}

type WeekState = PanelState & { store?: number; week?: string; top?: number; errField?: string };

// storeAndWeek draws the store and week fields on line 3.
async function storeAndWeek(ctx: PosCtx, scr: Screen, s: WeekState): Promise<string | undefined> {
	const w = (await who(ctx))!;
	s.store ??= w.stores[0];
	s.week ??= monday(today(ctx));
	label(scr, 3, 2, "STORE ===>");
	scr.input(3, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
	const st = s.store ? await getStore(ctx.env.DB, s.store) : undefined;
	if (st) scr.text(3, 18, pad(st.name, 24), { color: "white" });
	label(scr, 3, 44, "WEEK OF ===>");
	scr.input(3, 57, 10, "week", s.week, { bright: s.errField === "week" });
	return st?.name;
}

// readStoreAndWeek reads the store and week fields, and PF4 and PF5 for
// the week before and after. It returns true when the screen should just
// be drawn again.
async function readStoreAndWeek(ctx: PosCtx, s: WeekState, inp: { aid: string; fields: Record<string, string> }, id: string): Promise<boolean> {
	const n = await storeField(ctx, inp.fields.store ?? "");
	const fail = (field: string, m: string) => {
		s.msg = msgId(ctx, `${id}E ${m}`);
		s.errField = field;
		withFill(s, { fields: inp.fields, cursor: field });
		return true;
	};
	if (typeof n === "string") return fail("store", n);
	const typed = (inp.fields.week ?? "").trim();
	if (!validDay(typed)) return fail("week", "WEEK OF IS A DATE, YYYY-MM-DD");
	const week = monday(typed);
	if (n !== s.store || week !== s.week) {
		s.store = n;
		s.week = week;
		s.top = 0;
		return true;
	}
	if (inp.aid === pf(4) || inp.aid === pf(5)) {
		s.week = addDays(week, inp.aid === pf(4) ? -7 : 7);
		s.top = 0;
		return true;
	}
	return false;
}

const dayHeads = (week: string) => DAYS.map((d, i) => `${d} ${md(addDays(week, i))}`);

// POS420 TIME CARDS: a store's week, hours by day for everyone who worked
// or was scheduled. S shows a person's punches.

export const timecards = guarded("timeclock", panel<TimeCardsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS420");
		header(scr, ctx, "TIME CARDS");
		await storeAndWeek(ctx, scr, s);
		scr.text(5, 2, "SELECT: S=TIME CARD   * ON THE CLOCK NOW   OVER 40 HOURS IN YELLOW", { color: "blue" });
		let head = "S OPER   NAME         ";
		for (const d of DAYS) head += lpad(d, 6);
		scr.text(6, 2, `${head}WORKED  SCHED`, { color: "white", bright: true });
		rule(scr, 7);
		s.keys = [];
		if (s.store) {
			const rows = await timeCards(ctx.env.DB, s.store, s.week!, ctx.tzOffset);
			s.total = rows.length;
			const shown = rows.slice(s.top ?? 0, (s.top ?? 0) + listRows(ctx));
			s.keys = shown.map((r) => String(r.emp));
			rowCount(scr, s.top ?? 0, shown.length, rows.length);
			if (rows.length === 0) scr.text(FIRST, 4, "NOBODY WORKED OR WAS SCHEDULED THIS WEEK", { color: "blue" });
			shown.forEach((r, i) => {
				const row = FIRST + i;
				scr.input(row, 2, 1, `sel:${r.emp}`, "", { bright: s.errSel === `sel:${r.emp}` });
				scr.text(row, 4, pad(r.operator, 6), { color: "turquoise" });
				scr.text(row, 11, pad(r.name, 12) + (r.onClock ? "*" : " "), { color: "green" });
				scr.text(row, 24, r.days.map((m) => lpad(hrs(m), 6)).join(""), { color: "green" });
				scr.text(row, 66, lpad(hours(r.worked), 6), { color: r.worked > OVERTIME ? "yellow" : "green", bright: r.worked > OVERTIME });
				scr.text(row, 73, lpad(hrs(r.scheduled), 6), { color: "green" });
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF4=WEEK BEFORE  PF5=WEEK AFTER  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? s.errSel ?? (s.keys.length ? `sel:${s.keys[0]}` : "store"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = s.errSel = undefined;
		if (scroll(ctx, inp.aid, s)) return s;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER" && inp.aid !== pf(4) && inp.aid !== pf(5)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		if (await readStoreAndWeek(ctx, s, inp, "4201")) return s;
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "timecard", back: s, store: s.store!, week: s.week!, emp: Number(x.key) } satisfies TimeCardState;
			s.msg = `${msgId(ctx, "4202E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS421 TIME CARD: one person's punches at a store in a week. Times are
// changed in place, D deletes a punch, and the last line adds one; every
// change needs a reason, kept with the punch and in the audit log.

const MOST = 11; // punches shown, leaving room for the new one and the reason

export const timecard = guarded("timeclock", panel<TimeCardState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS421");
		header(scr, ctx, "TIME CARD");
		const e = await getEmployee(ctx.env.DB, s.emp);
		scr.text(3, 2, `STORE ${s.store}  WEEK OF ${s.week}  OPERATOR ${e?.operator ?? ""} ${e?.name ?? ""}`, { color: "turquoise" });
		const punches = await timeCard(ctx.env.DB, s.store, s.emp, s.week, ctx.tzOffset);
		const at = new Date().toISOString();
		const worked = punches.reduce((m, p) => m + minutesBetween(p.inAt, p.outAt ?? at), 0);
		const sched = (await timeCards(ctx.env.DB, s.store, s.week, ctx.tzOffset)).find((r) => r.emp === s.emp)?.scheduled ?? 0;
		scr.text(4, 2, `WORKED ${hours(worked)}  SCHEDULED ${hours(sched)}${punches.some((p) => !p.outAt) ? "  ON THE CLOCK NOW" : ""}`, {
			color: worked > OVERTIME ? "yellow" : "white", bright: true,
		});
		scr.text(5, 2, "SELECT: D=DELETE   TIMES ARE YYYY-MM-DD HH:MM; NO OUT IS STILL ON THE CLOCK", { color: "blue" });
		scr.text(6, 2, "D IN                OUT                HOURS REG  EDITED BY NOTE", { color: "white", bright: true });
		rule(scr, 7);
		const shown = punches.slice(0, MOST);
		s.keys = shown.map((p) => String(p.id));
		shown.forEach((p, i) => {
			const row = FIRST + i;
			scr.input(row, 2, 1, `sel:${p.id}`, "", { bright: s.errSel === `sel:${p.id}` });
			scr.input(row, 4, 16, `in:${p.id}`, stamp(ctx, p.inAt), { bright: s.errField === `in:${p.id}` });
			scr.input(row, 22, 16, `out:${p.id}`, p.outAt ? stamp(ctx, p.outAt) : "", { bright: s.errField === `out:${p.id}` });
			scr.text(row, 40, lpad(hours(minutesBetween(p.inAt, p.outAt ?? at)), 6), { color: "green" });
			scr.text(row, 47, lpad(p.reg ?? "", 3), { color: "green" });
			scr.text(row, 52, pad(p.editedBy ?? "", 9), { color: "yellow" });
			scr.text(row, 62, pad(p.note, 18), { color: "yellow" });
		});
		const add = FIRST + shown.length;
		scr.text(add, 2, "+", { color: "white" });
		scr.input(add, 4, 16, "in:new", "", { bright: s.errField === "in:new" });
		scr.input(add, 22, 16, "out:new", "", { bright: s.errField === "out:new" });
		scr.text(add, 40, "ADD A PUNCH", { color: "blue" });
		if (punches.length > MOST) scr.text(add + 1, 4, `SHOWING ${MOST} OF ${punches.length} PUNCHES`, { color: "yellow" });
		label(scr, ctx.rows - 3, 2, "REASON ===>");
		scr.input(ctx.rows - 3, 14, 40, "reason", "", { bright: s.errField === "reason" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  ENTER=SAVE CHANGES");
		scr.cursorTo(s.errField ?? s.errSel ?? (s.keys.length ? `in:${s.keys[0]}` : "in:new"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = s.errSel = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const tz = ctx.tzOffset;
		const reason = (inp.fields.reason ?? "").trim().toUpperCase().slice(0, 40);
		const fail = (field: string, m: string, id = "4211E") => {
			s.msg = `${msgId(ctx, id)} ${m}`;
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const punches = await timeCard(ctx.env.DB, s.store, s.emp, s.week, tz);
		const byId = new Map(punches.map((p) => [String(p.id), p]));
		let done = 0;
		try {
			const deleting = new Set<string>();
			for (const x of selected(inp, s.keys ?? [])) {
				if (x.code !== "D") {
					s.errSel = x.field;
					return fail(x.field, `INVALID SELECTION CODE "${x.code}" - TYPE D`, "4212E");
				}
				deleting.add(x.key);
			}
			for (const id of deleting) {
				await deletePunch(ctx.env.DB, ctx.user, s.emp, Number(id), reason);
				done++;
			}
			for (const id of s.keys ?? []) {
				const p = byId.get(id);
				const tin = inp.fields[`in:${id}`];
				const tout = inp.fields[`out:${id}`];
				if (!p || deleting.has(id) || tin === undefined || tout === undefined) continue;
				if (tin.trim() === stamp(ctx, p.inAt) && tout.trim() === (p.outAt ? stamp(ctx, p.outAt) : "")) continue;
				const inAt = readTime(tin, tz);
				if (!inAt) return fail(`in:${id}`, "IN IS YYYY-MM-DD HH:MM");
				const outAt = tout.trim() ? readTime(tout, tz) : null;
				if (outAt === undefined) return fail(`out:${id}`, "OUT IS YYYY-MM-DD HH:MM, OR BLANK IF STILL ON THE CLOCK");
				await savePunch(ctx.env.DB, ctx.user, { id: p.id, emp: s.emp, store: s.store, inAt, outAt, reason }, { in: `in:${id}`, out: `out:${id}` });
				done++;
			}
			const nin = (inp.fields["in:new"] ?? "").trim();
			const nout = (inp.fields["out:new"] ?? "").trim();
			if (nin || nout) {
				const inAt = readTime(nin, tz);
				if (!inAt) return fail("in:new", "IN IS YYYY-MM-DD HH:MM");
				const outAt = nout ? readTime(nout, tz) : null;
				if (outAt === undefined) return fail("out:new", "OUT IS YYYY-MM-DD HH:MM, OR BLANK IF STILL ON THE CLOCK");
				await savePunch(ctx.env.DB, ctx.user, { emp: s.emp, store: s.store, inAt, outAt, reason }, { in: "in:new", out: "out:new" });
				done++;
			}
		} catch (e) {
			if (!(e instanceof Invalid)) throw e;
			return fail(e.field, e.message);
		}
		if (done) s.msg = `${msgId(ctx, "4213I")} ${done} CHANGE(S) SAVED`;
		return s;
	},
}));

// POS430 SCHEDULE: a store's week of shifts, two lines a person. Shifts
// are typed in place; PF6 copies last week into the days left blank.

export const schedule = guarded("timeclock", panel<ScheduleState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS430");
		header(scr, ctx, "SCHEDULE");
		await storeAndWeek(ctx, scr, s);
		scr.text(5, 2, "SHIFTS ARE 0900-1700 (OR 9-17); BLANK IS A DAY OFF", { color: "blue" });
		scr.text(6, 2, "OPER", { color: "white", bright: true });
		dayHeads(s.week!).forEach((h, i) => scr.text(6, 10 + i * 10, h, { color: "white", bright: true }));
		rule(scr, 7);
		s.keys = [];
		if (s.store) {
			const rows = await roster(ctx.env.DB, s.store, s.week!);
			const per = Math.max(Math.floor(listRows(ctx) / 2), 1);
			s.total = rows.length;
			const shown = rows.slice(s.top ?? 0, (s.top ?? 0) + per);
			s.keys = shown.map((r) => String(r.emp));
			rowCount(scr, s.top ?? 0, shown.length, rows.length);
			if (rows.length === 0) scr.text(FIRST, 4, "NOBODY WITH AN OPERATOR ID WORKS AT THIS STORE", { color: "blue" });
			const daily = [0, 0, 0, 0, 0, 0, 0];
			for (const r of rows) r.shifts.forEach((sh, i) => (daily[i] += sh ? minutesOf(sh) : 0));
			shown.forEach((r, i) => {
				const row = FIRST + i * 2;
				const total = r.shifts.reduce((m, sh) => m + (sh ? minutesOf(sh) : 0), 0);
				scr.text(row, 2, pad(r.operator, 7) + r.name, { color: "turquoise" });
				scr.text(row, 60, `HOURS ${lpad(hours(total), 6)}`, { color: total > OVERTIME ? "yellow" : "green" });
				r.shifts.forEach((sh, d) => {
					const f = `sh:${r.emp}:${d}`;
					scr.input(row + 1, 10 + d * 10, 9, f, showShift(sh), { bright: s.errField === f });
				});
			});
			scr.text(ctx.rows - 2, 2, "HOURS", { color: "white" });
			daily.forEach((m, i) => scr.text(ctx.rows - 2, 10 + i * 10, lpad(hrs(m), 9), { color: "green" }));
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF4=WEEK BEFORE  PF5=WEEK AFTER  PF6=COPY LAST WEEK  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? (s.keys.length ? `sh:${s.keys[0]}:0` : "store"));
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		const per = Math.max(Math.floor(listRows(ctx) / 2), 1);
		if (inp.aid === pf(7) || inp.aid === pf(8)) {
			const top = s.top ?? 0;
			if (inp.aid === pf(7)) {
				if (top === 0) s.msg = `${msgId(ctx, "0003W")} ALREADY AT TOP OF DATA`;
				s.top = Math.max(top - per, 0);
			} else if (top + per >= (s.total ?? 0)) s.msg = `${msgId(ctx, "0004W")} ALREADY AT BOTTOM OF DATA`;
			else s.top = top + per;
			return s;
		}
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER" && inp.aid !== pf(4) && inp.aid !== pf(5) && inp.aid !== pf(6)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		if (await readStoreAndWeek(ctx, s, inp, "4301")) return s;
		const store = s.store!;
		const week = s.week!;
		const rows = await roster(ctx.env.DB, store, week);
		const changes: { emp: number; day: string; shift: Shift | null }[] = [];
		for (const key of s.keys ?? []) {
			const r = rows.find((x) => String(x.emp) === key);
			if (!r) continue;
			for (let d = 0; d < 7; d++) {
				const f = `sh:${key}:${d}`;
				const typed = inp.fields[f];
				if (typed === undefined || typed.trim() === showShift(r.shifts[d])) continue;
				const shift = readShift(typed);
				if (shift === undefined) {
					s.msg = `${msgId(ctx, "4302E")} A SHIFT IS 0900-1700, OR BLANK FOR A DAY OFF`;
					s.errField = f;
					return withFill(s, { fields: inp.fields, cursor: f });
				}
				if (showShift(shift ?? undefined) !== showShift(r.shifts[d])) changes.push({ emp: r.emp, day: addDays(week, d), shift });
			}
		}
		await saveShifts(ctx.env.DB, ctx.user, store, week, changes);
		if (inp.aid === pf(6)) {
			const n = await copyWeek(ctx.env.DB, ctx.user, store, week);
			s.msg = `${msgId(ctx, "4304I")} ${n} SHIFT(S) COPIED FROM THE WEEK OF ${addDays(week, -7)}`;
			return s;
		}
		if (changes.length) s.msg = `${msgId(ctx, "4303I")} ${changes.length} SHIFT(S) SAVED`;
		return s;
	},
}));

const minutesOf = (sh: Shift) => shiftMinutes(sh.starts, sh.ends);
