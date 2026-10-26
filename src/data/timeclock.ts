// The time clock and the schedule. People punch in and out at a register
// with their operator ID and PIN; managers fix punches and keep the
// week's schedule in the back office. Punches are kept as UTC times;
// days and shifts are the store's local ones, so the screens pass the
// terminal's offset from UTC (minutes) where it matters.

import { audit, Invalid, nextId, now, unique } from "./db";

export interface Punch {
	id: number;
	emp: number;
	store: number;
	reg: number | null;
	inAt: string;
	outAt: string | null;
	editedBy: string | null;
	note: string;
}

const PUNCH = "id, emp, store, reg, in_at AS inAt, out_at AS outAt, edited_by AS editedBy, note";

// --- Days and times ---

const DAY = 86400000;

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// monday is the Monday of the week a day falls in.
export function monday(day: string): string {
	const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay(); // 0 is Sunday
	return addDays(day, -((dow + 6) % 7));
}

export const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

// localDay is the local date of a UTC time; utcOf the UTC time of a local
// "YYYY-MM-DD HH:MM".
export const localDay = (iso: string, tz: number) => new Date(Date.parse(iso) + tz * 60000).toISOString().slice(0, 10);
export const utcOf = (local: string, tz: number) => new Date(Date.parse(`${local.replace(" ", "T")}:00Z`) - tz * 60000).toISOString();

// readTime reads a local "YYYY-MM-DD HH:MM" as typed.
export function readTime(s: string, tz: number): string | undefined {
	const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/.exec(s.trim());
	if (!m || !validDay(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) return undefined;
	return utcOf(`${m[1]} ${m[2].padStart(2, "0")}:${m[3]}`, tz);
}

export const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60000);

export const hours = (minutes: number) => (minutes / 60).toFixed(2);

// --- Punching in and out ---

export async function openPunch(db: D1Database, emp: number): Promise<Punch | undefined> {
	return (await db.prepare(`SELECT ${PUNCH} FROM punches WHERE emp = ? AND out_at IS NULL`).bind(emp).first<Punch>()) ?? undefined;
}

export type Punched = { kind: "in"; at: string } | { kind: "out"; at: string; minutes: number };

// punch clocks an operator in at a register, or out if they are on the
// clock (wherever they clocked in).
export async function punch(db: D1Database, op: { emp: number; operator: string }, store: number, reg: number): Promise<Punched> {
	const at = now();
	const open = await openPunch(db, op.emp);
	const actor = `OP${op.operator}`;
	if (open) {
		await db.batch([
			db.prepare("UPDATE punches SET out_at = ? WHERE id = ? AND out_at IS NULL").bind(at, open.id),
			audit(db, actor, { action: "TIME.OUT", subject: String(op.emp), store, reg, detail: `punch=${open.id}` }, at),
		]);
		return { kind: "out", at, minutes: minutesBetween(open.inAt, at) };
	}
	await unique(
		db.batch([
			db.prepare(`INSERT INTO punches (id, emp, store, reg, in_at) VALUES (${nextId("punches")}, ?, ?, ?, ?)`).bind(op.emp, store, reg, at),
			audit(db, actor, { action: "TIME.IN", subject: String(op.emp), store, reg }, at),
		]),
		new Invalid("operator", "ALREADY ON THE CLOCK - TRY AGAIN"),
	);
	return { kind: "in", at };
}

// --- Time cards ---

export interface CardRow {
	emp: number;
	operator: string;
	name: string;
	days: number[]; // minutes worked, Monday first
	worked: number;
	scheduled: number;
	onClock: boolean;
}

// punchesIn lists a store's punches that start between two times.
async function punchesIn(db: D1Database, store: number, from: string, to: string, emp?: number): Promise<Punch[]> {
	return (await db.prepare(`SELECT ${PUNCH} FROM punches WHERE store = ? AND in_at >= ? AND in_at < ? ${emp ? "AND emp = ?" : ""} ORDER BY in_at`)
		.bind(...[store, from, to, ...(emp ? [emp] : [])]).all<Punch>()).results;
}

const weekBounds = (week: string, tz: number) => ({ from: utcOf(`${week} 00:00`, tz), to: utcOf(`${addDays(week, 7)} 00:00`, tz) });

// timeCards adds up a store's week, Monday to Sunday, for everyone who
// worked or was scheduled. A punch still open counts to now.
export async function timeCards(db: D1Database, store: number, week: string, tz: number): Promise<CardRow[]> {
	const { from, to } = weekBounds(week, tz);
	const at = now();
	const [punches, sched, people] = await Promise.all([
		punchesIn(db, store, from, to),
		db.prepare("SELECT emp, starts, ends FROM shifts WHERE store = ? AND day >= ? AND day < ?").bind(store, week, addDays(week, 7))
			.all<{ emp: number; starts: string; ends: string }>(),
		db.prepare("SELECT emp, COALESCE(operator, '') AS operator, name FROM employees").all<{ emp: number; operator: string; name: string }>(),
	]);
	const rows = new Map<number, CardRow>();
	const row = (emp: number) => {
		let r = rows.get(emp);
		if (!r) {
			const p = people.results.find((x) => x.emp === emp);
			r = { emp, operator: p?.operator ?? "", name: p?.name ?? `EMP ${emp}`, days: [0, 0, 0, 0, 0, 0, 0], worked: 0, scheduled: 0, onClock: false };
			rows.set(emp, r);
		}
		return r;
	};
	for (const p of punches) {
		const r = row(p.emp);
		const m = minutesBetween(p.inAt, p.outAt ?? at);
		const i = Math.round((Date.parse(`${localDay(p.inAt, tz)}T00:00:00Z`) - Date.parse(`${week}T00:00:00Z`)) / DAY);
		r.days[Math.min(Math.max(i, 0), 6)] += m;
		r.worked += m;
		if (!p.outAt) r.onClock = true;
	}
	for (const s of sched.results) row(s.emp).scheduled += shiftMinutes(s.starts, s.ends);
	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// timeCard is one person's punches at a store in a week.
export async function timeCard(db: D1Database, store: number, emp: number, week: string, tz: number): Promise<Punch[]> {
	const { from, to } = weekBounds(week, tz);
	return punchesIn(db, store, from, to, emp);
}

// savePunch changes a punch, or adds one (no id), from the back office.
// A punch has no out only while the person is still on the clock.
export async function savePunch(
	db: D1Database, userid: string, p: { id?: number; emp: number; store: number; inAt: string; outAt: string | null; reason: string },
	fields: { in: string; out: string },
): Promise<void> {
	const at = now();
	if (!p.reason) throw new Invalid("reason", "KEY A REASON FOR THE CHANGE");
	if (p.inAt > at) throw new Invalid(fields.in, "CAN'T CLOCK IN IN THE FUTURE");
	if (p.outAt !== null) {
		if (p.outAt > at) throw new Invalid(fields.out, "CAN'T CLOCK OUT IN THE FUTURE");
		if (p.outAt <= p.inAt) throw new Invalid(fields.out, "OUT MUST BE AFTER IN");
		if (minutesBetween(p.inAt, p.outAt) > 24 * 60) throw new Invalid(fields.out, "A PUNCH CAN'T BE OVER 24 HOURS");
	}
	const overlap = await db.prepare(`SELECT id FROM punches WHERE emp = ? AND id <> ? AND in_at < COALESCE(?, '9999') AND COALESCE(out_at, '9999') > ?`)
		.bind(p.emp, p.id ?? 0, p.outAt, p.inAt).first<{ id: number }>();
	if (overlap) throw new Invalid(fields.in, `OVERLAPS ANOTHER PUNCH (${overlap.id})`);
	const open = new Invalid(fields.out, "ALREADY ON THE CLOCK - KEY AN OUT TIME");
	if (p.id) {
		const was = await db.prepare(`SELECT ${PUNCH} FROM punches WHERE id = ? AND emp = ?`).bind(p.id, p.emp).first<Punch>();
		if (!was) throw new Invalid(fields.in, `PUNCH ${p.id} IS GONE`);
		await unique(db.batch([
			db.prepare("UPDATE punches SET in_at = ?, out_at = ?, edited_by = ?, note = ? WHERE id = ?").bind(p.inAt, p.outAt, userid, p.reason, p.id),
			audit(db, userid, {
				action: "TIME.EDIT", subject: String(p.id), store: p.store,
				detail: `emp=${p.emp} in=${p.inAt} out=${p.outAt ?? ""} was=${was.inAt}/${was.outAt ?? ""} reason=${p.reason}`,
			}, at),
		]), open);
		return;
	}
	await unique(db.batch([
		db.prepare(`INSERT INTO punches (id, emp, store, in_at, out_at, edited_by, note) VALUES (${nextId("punches")}, ?, ?, ?, ?, ?, ?)`).bind(p.emp, p.store, p.inAt, p.outAt, userid, p.reason),
		audit(db, userid, { action: "TIME.ADD", subject: String(p.emp), store: p.store, detail: `in=${p.inAt} out=${p.outAt ?? ""} reason=${p.reason}` }, at),
	]), open);
}

export async function deletePunch(db: D1Database, userid: string, emp: number, id: number, reason: string): Promise<void> {
	if (!reason) throw new Invalid("reason", "KEY A REASON FOR THE CHANGE");
	const was = await db.prepare(`SELECT ${PUNCH} FROM punches WHERE id = ? AND emp = ?`).bind(id, emp).first<Punch>();
	if (!was) return;
	await db.batch([
		db.prepare("DELETE FROM punches WHERE id = ?").bind(id),
		audit(db, userid, { action: "TIME.DELETE", subject: String(id), store: was.store, detail: `emp=${emp} was=${was.inAt}/${was.outAt ?? ""} reason=${reason}` }),
	]);
}

// --- The schedule ---

export interface Shift {
	starts: string; // HH:MM
	ends: string;
}

// readShift reads a shift as typed: 0900-1700, 9-17, 9:30-17:30. Blank is
// no shift; undefined is one that can't be read.
export function readShift(s: string): Shift | null | undefined {
	const t = s.trim();
	if (!t) return null;
	const m = /^(\d{1,2}):?(\d{2})?-(\d{1,2}):?(\d{2})?$/.exec(t);
	if (!m) return undefined;
	const hm = (h: string, mm = "00") => (Number(h) > 23 || Number(mm) > 59 ? undefined : `${h.padStart(2, "0")}:${mm}`);
	const starts = hm(m[1], m[2]);
	const ends = hm(m[3], m[4]);
	if (!starts || !ends || starts === ends) return undefined;
	return { starts, ends };
}

export const showShift = (s: Shift | undefined) => (s ? `${s.starts.replace(":", "")}-${s.ends.replace(":", "")}` : "");

// shiftMinutes is how long a shift is; one that ends at or before it
// starts ends the next day.
export function shiftMinutes(starts: string, ends: string): number {
	const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
	const d = m(ends) - m(starts);
	return d > 0 ? d : d + 1440;
}

export interface RosterRow {
	emp: number;
	operator: string;
	name: string;
	shifts: (Shift | undefined)[]; // Monday first
}

// roster is who can be scheduled at a store in a week: active operators
// who may work there, and anyone already scheduled.
export async function roster(db: D1Database, store: number, week: string): Promise<RosterRow[]> {
	const end = addDays(week, 7);
	const [people, shifts] = await db.batch<Record<string, string | number>>([
		db.prepare(`SELECT emp, COALESCE(operator, '') AS operator, name FROM employees e
			WHERE (status = 'A' AND operator IS NOT NULL AND (EXISTS (SELECT 1 FROM employee_stores s WHERE s.emp = e.emp AND s.store = ?)
				OR NOT EXISTS (SELECT 1 FROM employee_stores s WHERE s.emp = e.emp)))
			OR emp IN (SELECT emp FROM shifts WHERE store = ? AND day >= ? AND day < ?)
			ORDER BY name, emp`).bind(store, store, week, end),
		db.prepare("SELECT emp, day, starts, ends FROM shifts WHERE store = ? AND day >= ? AND day < ?").bind(store, week, end),
	]);
	const rows = (people.results as unknown as { emp: number; operator: string; name: string }[])
		.map((p) => ({ ...p, shifts: Array<Shift | undefined>(7).fill(undefined) }));
	for (const s of shifts.results as unknown as { emp: number; day: string; starts: string; ends: string }[]) {
		const r = rows.find((x) => x.emp === s.emp);
		const i = Math.round((Date.parse(`${s.day}T00:00:00Z`) - Date.parse(`${week}T00:00:00Z`)) / DAY);
		if (r && i >= 0 && i < 7) r.shifts[i] = { starts: s.starts, ends: s.ends };
	}
	return rows;
}

// saveShifts sets or clears shifts at a store; a null shift is a day off.
export async function saveShifts(db: D1Database, userid: string, store: number, week: string, changes: { emp: number; day: string; shift: Shift | null }[]): Promise<void> {
	if (changes.length === 0) return;
	const at = now();
	await db.batch([
		...changes.map((c) =>
			c.shift
				? db.prepare(`INSERT INTO shifts (store, emp, day, starts, ends, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (store, emp, day) DO UPDATE SET starts = excluded.starts, ends = excluded.ends, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
					.bind(store, c.emp, c.day, c.shift.starts, c.shift.ends, at, userid)
				: db.prepare("DELETE FROM shifts WHERE store = ? AND emp = ? AND day = ?").bind(store, c.emp, c.day),
		),
		audit(db, userid, { action: "SCHED.SET", subject: `${store}/${week}`, store, detail: changes.map((c) => `${c.emp}@${c.day}=${showShift(c.shift ?? undefined) || "OFF"}`).join(" ").slice(0, 500) }, at),
	]);
}

// copyWeek copies last week's shifts into this week, leaving any day
// already scheduled as it is. It returns how many it copied.
export async function copyWeek(db: D1Database, userid: string, store: number, week: string): Promise<number> {
	const at = now();
	const [r] = await db.batch([
		db.prepare(`INSERT OR IGNORE INTO shifts (store, emp, day, starts, ends, updated_at, updated_by)
			SELECT store, emp, date(day, '+7 days'), starts, ends, ?, ? FROM shifts WHERE store = ? AND day >= ? AND day < ?`)
			.bind(at, userid, store, addDays(week, -7), week),
		audit(db, userid, { action: "SCHED.COPY", subject: `${store}/${week}`, store, detail: `from=${addDays(week, -7)}` }, at),
	]);
	return r.meta.changes ?? 0;
}
