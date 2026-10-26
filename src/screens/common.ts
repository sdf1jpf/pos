// What the back-office panels share: the role check every panel makes,
// form and list layout, and turning a refused change into the message line.

import {
	dots, header, keys, label, message, msgId, newScreen, pf, withFill,
	type Input, type MenuState, type PanelState, type Program, type Screen,
} from "@greenscreen-dev/worker";
import { can, who, type Right } from "../access";
import { Conflict, Invalid, NotFound } from "../data/db";
import type { Env } from "../env";
import type { PosCtx } from "./types";

// guarded lets only people with a right use a panel. The menu shows only
// the options a person may use, but a role can change while someone is
// signed on, so every panel checks again on every key.
export function guarded<S extends PanelState>(right: Right, p: Program<S, Env>): Program<S, Env> {
	return {
		async render(ctx, s) {
			if (can(await who(ctx), right)) return p.render(ctx, s);
			const scr = newScreen(ctx, "POS000");
			header(scr, ctx, "NOT AUTHORIZED");
			message(scr, notAuthorized(ctx));
			keys(scr, "PF3=MENU");
			scr.setCursor(scr.rows, 2);
			return scr;
		},
		async handle(ctx, s, inp) {
			if (can(await who(ctx), right)) return p.handle(ctx, s, inp);
			return { p: "menu", msg: notAuthorized(ctx) } satisfies MenuState;
		},
	};
}

export function notAuthorized(ctx: PosCtx): string {
	return `${msgId(ctx, "0002E")} ${ctx.user} IS NOT AUTHORIZED FOR THIS FUNCTION`;
}

// refused turns a change the data layer refused into the panel's message
// and bad field, keeping what the operator typed. Anything else is thrown.
export function refused<S extends PanelState & { errField?: string }>(ctx: PosCtx, s: S, inp: Input, e: unknown, id: string): S {
	if (e instanceof Invalid) {
		s.msg = `${msgId(ctx, id + "E")} ${e.message}`;
		s.errField = e.field;
		return withFill(s, { fields: inp.fields, cursor: s.errField });
	}
	if (e instanceof Conflict || e instanceof NotFound) {
		// Show the record as it is now, at its new version, to be reviewed
		// and changed again.
		s.msg = `${msgId(ctx, id + "W")} ${e.message}`;
		s.errField = undefined;
		delete (s as { version?: number }).version;
		return s;
	}
	throw e;
}

// Forms: a dotted label in column 2 and the field in column FIELD_COL, with
// an optional note after it.
export const FIELD_COL = 20;

export interface FormField {
	row: number;
	label: string;
	name: string;
	len: number;
	value: string;
	col?: number; // a second field on the line: its label goes just before it
	note?: string;
	protect?: boolean; // shown, not typed over (a key)
	numeric?: boolean;
}

export function form(scr: Screen, fields: FormField[], errField?: string): void {
	for (const f of fields) {
		const col = f.col ?? FIELD_COL;
		if (f.col) label(scr, f.row, col - f.label.length - 1, f.label);
		else if (f.label) label(scr, f.row, 2, dots(f.label, FIELD_COL - 3));
		if (f.protect) scr.text(f.row, col, f.value, { color: "white", bright: true });
		else scr.input(f.row, col, f.len, f.name, f.value, { bright: errField === f.name, numeric: f.numeric });
		if (f.note) scr.text(f.row, col + f.len + 2, f.note.slice(0, scr.cols - col - f.len - 3), { color: "blue" });
	}
}

// pick reads the typed values of fields named in keys, "" for any not sent.
export function pick<K extends string>(inp: Input, names: readonly K[]): Record<K, string> {
	return Object.fromEntries(names.map((n) => [n, inp.fields[n] ?? ""])) as Record<K, string>;
}

// Lists start at row FIRST under a column heading and a rule, and fill the
// screen down to the line above the message line.
export const FIRST = 8;

export function listRows(ctx: PosCtx, first = FIRST): number {
	return Math.max(ctx.rows - 3 - first + 1, 1);
}

export function rowCount(scr: Screen, top: number, shown: number, total: number, row = 4): void {
	const t = total === 0 ? "NO ROWS" : `ROW ${top + 1} TO ${top + shown} OF ${total}`;
	scr.text(row, scr.cols - t.length - 1, t, { color: "white" });
}

export function rule(scr: Screen, row: number): void {
	scr.text(row, 2, "-".repeat(scr.cols - 3), { color: "blue" });
}

// scroll handles PF7 and PF8 on a list, moving its top row and saying so
// at either end. It returns false for any other key.
export function scroll(ctx: PosCtx, aid: string, s: PanelState & { top?: number; total?: number }, first = FIRST): boolean {
	const rows = listRows(ctx, first);
	const top = s.top ?? 0;
	if (aid === pf(7)) {
		if (top === 0) s.msg = `${msgId(ctx, "0003W")} ALREADY AT TOP OF DATA`;
		s.top = Math.max(top - rows, 0);
		return true;
	}
	if (aid === pf(8)) {
		if (top + rows >= (s.total ?? 0)) s.msg = `${msgId(ctx, "0004W")} ALREADY AT BOTTOM OF DATA`;
		else s.top = top + rows;
		return true;
	}
	return false;
}

// selected finds the selection codes typed beside list rows (fields named
// "sel:<key>"), in screen order.
export function selected(inp: Input, keys: string[]): { key: string; code: string; field: string }[] {
	return keys
		.map((key) => ({ key, field: `sel:${key}`, code: (inp.fields[`sel:${key}`] ?? "").trim().toUpperCase() }))
		.filter((x) => x.code !== "");
}

export const yn = (b: boolean) => (b ? "Y" : "N");
