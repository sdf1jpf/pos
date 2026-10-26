import { clock, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, stamp, withFill } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { Invalid } from "../data/db";
import { businessDay, getDay, listDays, nextDay, openDrawers, reopenDay, startClose, zReport, type Z } from "../data/endofday";
import { getStore, storeNumber } from "../data/stores";
import type { Env } from "../env";
import { dollars } from "../money";
import { FIRST, guarded, listRows, rowCount, rule, scroll, selected } from "./common";
import type { CloseState, DaysState, PosCtx, ZState } from "./types";

// End of day, menu 5. Maps are POS510 to POS521.

const WIDTH = 40;
const both = (l: string, r: string) => pad(l, WIDTH - r.length - 1) + " " + r;
const center = (s: string) => pad(" ".repeat(Math.max(Math.floor((WIDTH - s.length) / 2), 0)) + s, WIDTH);
const TENDER = { CASH: "CASH", CARD: "CARD", CHECK: "CHECKS", GIFT: "GIFT CARDS", CREDIT: "STORE CREDIT" } as Record<string, string>;

// zLines lays out a Z report as the 40-column printer would.
export function zLines(ctx: PosCtx, z: Z, name: string, closed?: { at: string; by: string }): string[] {
	const out = [center(name), center(`Z REPORT - STORE ${z.store}`), center(`BUSINESS DAY ${z.day}`), "-".repeat(WIDTH)];
	out.push(both("SALES", String(z.sales)), both("MERCHANDISE", dollars(z.merchandise)), both("RETURNS", dollars(z.returns)));
	out.push(both("GIFT CARDS SOLD", dollars(z.giftCards)), both("DISCOUNTS GIVEN", dollars(z.discounts)), both("TAX", dollars(z.tax)));
	out.push(both("TOTAL", dollars(z.total)), "");
	out.push(both("POST-VOIDS", `${z.voids} / ${dollars(z.voided)}`), both("CANCELLED SALES", String(z.cancels)), both("NO SALES", String(z.noSales)), "");
	out.push("TENDERS");
	for (const [k, v] of Object.entries(z.tenders)) out.push(both(`  ${TENDER[k] ?? k}`, dollars(v)));
	if (z.creditIssued) out.push(both("  STORE CREDIT ISSUED", dollars(z.creditIssued)));
	out.push(both("PAID IN", dollars(z.paidIn)), both("PAID OUT", dollars(z.paidOut)), "");
	out.push("DRAWERS          COUNTED  EXPECTED  OVER/SHORT".slice(0, WIDTH));
	for (const d of z.drawers) {
		out.push(`  REG ${String(d.reg).padStart(2, "0")}   ${lpad(dollars(d.counted), 10)}${lpad(dollars(d.expected), 10)}${lpad(dollars(d.overShort), 10)}`.slice(0, WIDTH));
	}
	out.push(both("  OVER/SHORT", dollars(z.overShort)), "", center("DEPOSIT SLIP"));
	out.push(both("CASH (LESS FLOATS)", dollars(z.deposit.cash)), both("CHECKS", dollars(z.deposit.checks)), both("DEPOSIT TOTAL", dollars(z.deposit.total)));
	out.push("", center(closed ? `CLOSED ${clock(ctx, closed.at)} BY ${closed.by}` : `AS OF ${clock(ctx, z.at)} - NOT CLOSED`));
	return out;
}

async function storeField(ctx: PosCtx, typed: string): Promise<number | string> {
	const n = storeNumber(typed);
	if (n === undefined) return "STORE MUST BE 1 TO 999";
	if (!(await getStore(ctx.env.DB, n))) return `STORE ${n} NOT FOUND`;
	if (!canStore((await who(ctx))!, n)) return `YOU MAY NOT WORK ON STORE ${n}`;
	return n;
}

const STATUS = { R: "CLOSING", C: "CLOSED", O: "REOPENED" } as const;

// POS510 CLOSE THE DAY: a store's business day, its drawers and its Z
// report so far. PF10 closes it once every drawer is closed: the close
// runs in the background, and Enter shows how it is going. PF11 (admins)
// reopens the last day closed.

export const closeDay = guarded("endofday", panel<CloseState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS510");
		header(scr, ctx, "CLOSE THE DAY");
		const w = (await who(ctx))!;
		s.store ??= w.stores[0];
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		const store = s.store ? await getStore(ctx.env.DB, s.store) : undefined;
		if (!store) {
			scr.text(5, 4, "KEY A STORE", { color: "blue" });
			message(scr, s.msg ?? "");
			keys(scr, "PF3=EXIT  ENTER=SHOW");
			scr.cursorTo("store");
			return scr;
		}
		scr.text(3, 18, store.name, { color: "white" });
		const day = await businessDay(ctx.env.DB, store.store);
		const last = s.closing ? await getDay(ctx.env.DB, store.store, s.closing) : undefined;
		scr.text(4, 2, `BUSINESS DAY ${day}`, { color: "white", bright: true });
		if (last) {
			let how: string = STATUS[last.status];
			if (last.status === "R" && ctx.env.CLOSE_DAY && last.workflow) {
				const st = await (await ctx.env.CLOSE_DAY.get(last.workflow)).status().catch(() => undefined);
				if (st?.status === "errored" || st?.status === "terminated") how = `FAILED: ${String(st.error?.message ?? st.status).toUpperCase()}`.slice(0, 60);
			}
			scr.text(4, 30, `DAY ${last.day}: ${how}`, { color: last.status === "C" ? "green" : "yellow", bright: true });
		}
		const open = await openDrawers(ctx.env.DB, store.store);
		scr.text(6, 2, open.length ? "OPEN DRAWERS - CLOSE THEM AT THE REGISTER FIRST:" : "EVERY DRAWER IS CLOSED", { color: open.length ? "yellow" : "green" });
		open.slice(0, 4).forEach((d, i) => scr.text(7 + i, 4, `REG ${String(d.reg).padStart(2, "0")}  OPENED ${clock(ctx, d.openedAt)} BY ${d.by}`, { color: "turquoise" }));
		const z = await zReport(ctx.env.DB, store.store, day);
		const col = (r: number, c: number, l: string, v: string) => {
			label(scr, r, c, l);
			scr.text(r, c + 18, lpad(v, 12), { color: "green" });
		};
		scr.text(12, 2, `SO FAR TODAY`, { color: "white", bright: true });
		col(13, 2, "SALES", String(z.sales));
		col(14, 2, "TOTAL", dollars(z.total));
		col(15, 2, "TAX", dollars(z.tax));
		col(16, 2, "RETURNS", dollars(z.returns));
		col(13, 40, "CASH", dollars(z.tenders.CASH ?? 0));
		col(14, 40, "CARD", dollars(z.tenders.CARD ?? 0));
		col(15, 40, "OVER/SHORT", dollars(z.overShort));
		col(16, 40, "DEPOSIT", dollars(z.deposit.total));
		message(scr, s.msg ?? "");
		keys(scr, `PF3=EXIT  ENTER=REFRESH  PF10=CLOSE DAY ${day}${w.role === "ADMIN" ? "  PF11=REOPEN LAST DAY" : ""}`);
		scr.cursorTo("store");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		const n = await storeField(ctx, inp.fields.store ?? "");
		if (typeof n === "string") {
			s.msg = msgId(ctx, `5101E ${n}`);
			s.errField = "store";
			return withFill(s, { fields: inp.fields, cursor: "store" });
		}
		if (n !== s.store) {
			s.store = n;
			s.closing = undefined;
			return s;
		}
		if (inp.aid === "ENTER") return s;
		const w = (await who(ctx))!;
		if (inp.aid === pf(10)) {
			const day = await businessDay(ctx.env.DB, n);
			const today = stamp(ctx, new Date().toISOString()).slice(0, 10);
			if (day > today) {
				s.msg = `${msgId(ctx, "5106E")} DAY ${day} HASN'T STARTED YET`;
				return s;
			}
			const next = nextDay(day, today);
			const id = `close-${n}-${day}-${Date.now()}`;
			try {
				await startClose(ctx.env.DB, ctx.user, n, day, id);
			} catch (e) {
				if (!(e instanceof Invalid)) throw e;
				s.msg = `${msgId(ctx, "5102E")} ${e.message}`;
				return s;
			}
			if (!ctx.env.CLOSE_DAY) throw new Error("the CLOSE_DAY Workflow isn't bound");
			await ctx.env.CLOSE_DAY.create({ id, params: { store: n, day, next, userid: ctx.user } });
			s.closing = day;
			s.msg = `${msgId(ctx, "5103I")} CLOSING DAY ${day} - PRESS ENTER TO SEE WHEN IT IS DONE`;
			return s;
		}
		if (inp.aid === pf(11) && w.role === "ADMIN") {
			try {
				const day = await reopenDay(ctx.env.DB, ctx.user, n);
				s.closing = day;
				s.msg = `${msgId(ctx, "5104I")} DAY ${day} REOPENED - DRAWERS NOW OPEN ON IT`;
			} catch (e) {
				if (!(e instanceof Invalid)) throw e;
				s.msg = `${msgId(ctx, "5105E")} ${e.message}`;
			}
			return s;
		}
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));

// POS520 DAYS: a store's closed days. S shows a day's Z report.

export const days = guarded("endofday", panel<DaysState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS520");
		header(scr, ctx, "BUSINESS DAYS");
		const w = (await who(ctx))!;
		s.store ??= w.stores[0];
		label(scr, 3, 2, "STORE ===>");
		scr.input(3, 13, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		scr.text(5, 2, "SELECT: S=Z REPORT", { color: "blue" });
		scr.text(6, 2, "S DAY         STATUS     SALES         TOTAL   OVER/SHORT  CLOSED BY", { color: "white", bright: true });
		rule(scr, 7);
		s.keys = [];
		if (s.store) {
			const { days, total } = await listDays(ctx.env.DB, s.store, s.top ?? 0, listRows(ctx));
			s.keys = days.map((d) => d.day);
			s.total = total;
			rowCount(scr, s.top ?? 0, days.length, total);
			if (total === 0) scr.text(FIRST, 4, "NO DAY HAS BEEN CLOSED YET", { color: "blue" });
			days.forEach((d, i) => {
				const row = FIRST + i;
				scr.input(row, 2, 1, `sel:${d.day}`, "", { bright: s.errSel === `sel:${d.day}` });
				scr.text(row, 4, d.day, { color: "turquoise" });
				scr.text(row, 16, pad(STATUS[d.status], 9), { color: d.status === "C" ? "green" : "yellow" });
				if (d.z) {
					scr.text(row, 26, lpad(d.z.sales, 6), { color: "green" });
					scr.text(row, 33, lpad(dollars(d.z.total), 13), { color: "green" });
					scr.text(row, 47, lpad(dollars(d.z.overShort), 11), { color: d.z.overShort ? "yellow" : "green" });
				}
				scr.text(row, 61, pad(d.closedBy ?? "", 10), { color: "green" });
			});
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF7=UP  PF8=DOWN");
		scr.cursorTo(s.errField ?? s.errSel ?? (s.keys.length ? `sel:${s.keys[0]}` : "store"));
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
		const n = await storeField(ctx, inp.fields.store ?? "");
		if (typeof n === "string") {
			s.msg = msgId(ctx, `5201E ${n}`);
			s.errField = "store";
			return withFill(s, { fields: inp.fields, cursor: "store" });
		}
		if (n !== s.store) {
			s.store = n;
			s.top = 0;
			return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code === "S") return { p: "zreport", back: s, store: n, day: x.key } satisfies ZState;
			s.msg = `${msgId(ctx, "5202E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
			s.errSel = x.field;
			return s;
		}
		return s;
	},
}));

// POS521 Z REPORT: a closed day's Z report and deposit slip, to print.

export const zreport = guarded("endofday", panel<ZState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS521");
		header(scr, ctx, `Z REPORT - ${s.day}`);
		const d = await getDay(ctx.env.DB, s.store, s.day);
		const st = await getStore(ctx.env.DB, s.store);
		if (!d?.z || !st) {
			message(scr, `${msgId(ctx, "5211E")} NO Z REPORT FOR STORE ${s.store} ON ${s.day}`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		const lines = zLines(ctx, d.z, st.name, d.closedAt ? { at: d.closedAt, by: d.closedBy ?? "" } : undefined);
		const room = scr.rows - 5;
		const top = Math.min(s.top ?? 0, Math.max(lines.length - room, 0));
		s.top = top;
		lines.slice(top, top + room).forEach((l, i) => scr.text(3 + i, 20, l, { color: "white" }));
		if (lines.length > room) scr.text(3, 2, `LINE ${top + 1} OF ${lines.length}`, { color: "white" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF7=UP  PF8=DOWN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},
	handle(ctx, s, inp) {
		s.msg = undefined;
		const room = ctx.rows - 5;
		if (inp.aid === pf(7) || inp.aid === pf(8)) {
			s.top = Math.max((s.top ?? 0) + (inp.aid === pf(7) ? -room : room), 0);
			return s;
		}
		if (inp.aid === pf(3) || inp.aid === pf(12) || inp.aid === "ENTER") return s.back;
		s.msg = invalidKey(ctx, inp.aid);
		return s;
	},
}));
