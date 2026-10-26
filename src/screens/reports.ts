import { header, invalidKey, keys, label, message, msgId, newScreen, panel, pf, stamp, withDownload, withFill, type Ctx } from "@greenscreen-dev/worker";
import { can, canStore, who } from "../access";
import { dated, isReport, pages, REPORTS, runReport, type ReportCode, type ReportParams } from "../data/reports";
import { getStore, storeNumber } from "../data/stores";
import { localDay, validDay } from "../data/timeclock";
import type { Env } from "../env";
import { PAGE_LINES, pdf } from "../pdf";
import { guarded } from "./common";
import type { PosCtx, ReportState, ReportsState } from "./types";

// Reports, menu 6. Maps are POS610 and POS611; PF10 on a report prints it
// as a PDF, from GET /v1/report.pdf.

const today = (ctx: PosCtx) => localDay(new Date().toISOString(), ctx.tzOffset);

// POS610 REPORTS: which report, for which store and days.

export const reports = guarded("reports", panel<ReportsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS610");
		header(scr, ctx, "REPORTS");
		const w = (await who(ctx))!;
		label(scr, 3, 2, "REPORT ===>");
		scr.input(3, 14, 2, "report", s.report ?? "", { bright: s.errField === "report" });
		label(scr, 4, 2, "STORE ====>");
		scr.input(4, 14, 3, "store", s.store ? String(s.store) : "", { numeric: true, bright: s.errField === "store" });
		scr.text(4, 19, w.stores.length ? `BLANK FOR ALL YOUR STORES (${w.stores.join(", ")})` : "BLANK FOR ALL STORES", { color: "blue" });
		label(scr, 5, 2, "FROM =====>");
		scr.input(5, 14, 10, "from", s.from ?? today(ctx), { bright: s.errField === "from" });
		label(scr, 5, 26, "TO ===>");
		scr.input(5, 34, 10, "to", s.to ?? today(ctx), { bright: s.errField === "to" });
		scr.text(5, 46, "BUSINESS DAYS, YYYY-MM-DD", { color: "blue" });
		scr.text(7, 2, "SALES", { color: "white", bright: true });
		scr.text(7, 42, "INVENTORY (AS OF NOW)", { color: "white", bright: true });
		const codes = Object.entries(REPORTS) as [ReportCode, string][];
		codes.filter(([c]) => dated(c)).forEach(([c, t], i) => scr.text(8 + i, 4, `${c}  ${t}`, { color: "turquoise" }));
		codes.filter(([c]) => !dated(c)).forEach(([c, t], i) => scr.text(8 + i, 44, `${c}  ${t}`, { color: "turquoise" }));
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  ENTER=SHOW");
		scr.cursorTo(s.errField ?? "report");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const fail = (field: string, m: string) => {
			s.msg = `${msgId(ctx, "6101E")} ${m}`;
			s.errField = field;
			return withFill(s, { fields: inp.fields, cursor: field });
		};
		const report = (inp.fields.report ?? "").trim().toUpperCase();
		if (!isReport(report)) return fail("report", `REPORT IS ONE OF ${Object.keys(REPORTS).join(", ")}`);
		const w = (await who(ctx))!;
		const typed = (inp.fields.store ?? "").trim();
		let stores = w.stores;
		if (typed) {
			const n = storeNumber(typed);
			if (n === undefined) return fail("store", "STORE MUST BE 1 TO 999");
			if (!(await getStore(ctx.env.DB, n))) return fail("store", `STORE ${n} NOT FOUND`);
			if (!canStore(w, n)) return fail("store", `YOU MAY NOT WORK ON STORE ${n}`);
			stores = [n];
		}
		const from = (inp.fields.from ?? "").trim();
		const to = (inp.fields.to ?? "").trim();
		if (!validDay(from)) return fail("from", "FROM IS A DATE, YYYY-MM-DD");
		if (!validDay(to)) return fail("to", "TO IS A DATE, YYYY-MM-DD");
		if (to < from) return fail("to", "TO CAN'T BE BEFORE FROM");
		Object.assign(s, { report, store: stores.length === 1 && typed ? stores[0] : undefined, from, to });
		return { p: "report", back: s, report, stores, from, to } satisfies ReportState;
	},
}));

// POS611 a report on the screen: PF7 and PF8 page through it, PF10 prints it.

export const report = guarded("reports", panel<ReportState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS611");
		const rep = await runReport(ctx.env.DB, { ...s, tz: ctx.tzOffset });
		header(scr, ctx, rep.title);
		scr.text(3, 2, rep.sub, { color: "turquoise" });
		rep.head.forEach((h, i) => scr.text(4 + i, 2, h, { color: "white", bright: true }));
		const first = 4 + rep.head.length;
		const room = Math.max(ctx.rows - 2 - first, 1);
		const top = Math.min(s.top ?? 0, Math.max(rep.body.length - room, 0));
		s.top = top;
		rep.body.slice(top, top + room).forEach((line, i) => scr.text(first + i, 2, line, { color: "green" }));
		if (rep.body.length > room) {
			const where = `LINE ${top + 1} OF ${rep.body.length}`;
			scr.text(3, scr.cols - where.length - 1, where, { color: "white" });
		}
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF7=UP  PF8=DOWN  PF10=PRINT (PDF)");
		scr.setCursor(scr.rows, 2);
		return scr;
	},
	handle(ctx, s, inp) {
		s.msg = undefined;
		const room = Math.max(ctx.rows - 8, 1);
		switch (inp.aid) {
			case pf(3):
			case pf(12):
			case "ENTER":
				return s.back;
			case pf(7):
				s.top = Math.max((s.top ?? 0) - room, 0);
				return s;
			case pf(8):
				s.top = (s.top ?? 0) + room;
				return s;
			case pf(10): {
				const q = new URLSearchParams({ r: s.report, from: s.from, to: s.to, tz: String(ctx.tzOffset) });
				if (s.stores.length) q.set("stores", s.stores.join(","));
				s.msg = `${msgId(ctx, "6111I")} THE REPORT IS PRINTING TO A PDF`;
				return withDownload(s, { url: `/v1/report.pdf?${q}`, name: `${s.report}-${s.from}${s.to !== s.from ? `-${s.to}` : ""}.pdf` });
			}
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}
	},
}));

// reportPdf answers GET /v1/report.pdf for the signed-on user, checking
// their rights and stores again: the link can be passed around.
export async function reportPdf(env: Env, user: string, url: URL): Promise<Response> {
	const ctx = { env, user, tzOffset: Number(url.searchParams.get("tz") ?? 0) || 0 } as unknown as Ctx<Env>;
	const w = await who(ctx);
	const bad = (status: number, m: string) => new Response(m, { status, headers: { "content-type": "text/plain" } });
	if (!can(w, "reports")) return bad(403, "not authorized for reports");
	const r = (url.searchParams.get("r") ?? "").toUpperCase();
	const from = url.searchParams.get("from") ?? "";
	const to = url.searchParams.get("to") ?? "";
	if (!isReport(r) || !validDay(from) || !validDay(to)) return bad(400, "r, from and to are a report code and two dates");
	const asked = (url.searchParams.get("stores") ?? "").split(",").filter(Boolean).map(Number);
	if (asked.some((n) => !Number.isInteger(n) || !canStore(w!, n))) return bad(403, "not authorized for that store");
	const p: ReportParams = { report: r, stores: asked.length ? asked : w!.stores, from, to, tz: ctx.tzOffset };
	const rep = await runReport(env.DB, p);
	const printed = `PRINTED ${stamp(ctx, new Date().toISOString())} BY ${user}`;
	const body = pdf(pages(rep, printed, PAGE_LINES), 78, rep.title);
	return new Response(body, {
		headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${r}-${from}.pdf"`, "cache-control": "private, no-store" },
	});
}
