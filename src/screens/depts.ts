import { header, invalidKey, keys, label, lpad, message, msgId, newScreen, panel, pf } from "@greenscreen-dev/worker";
import { Invalid } from "../data/db";
import { addDepartment, listDepartments, updateDepartment } from "../data/items";
import type { Env } from "../env";
import { FIRST, guarded, listRows, refused, rowCount, rule, scroll, yn } from "./common";
import type { DeptsState } from "./types";

// POS120 DEPARTMENTS: the department table, changed in place. Type over a
// name, taxable flag or status and press Enter to save every changed row;
// fill in the top line to add one.

export const depts = guarded("items", panel<DeptsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS120");
		header(scr, ctx, "DEPARTMENTS");
		label(scr, 4, 2, "ADD: DEPT ===>");
		scr.input(4, 17, 3, "dept", "", { numeric: true, bright: s.errField === "dept" });
		label(scr, 4, 22, "NAME ===>");
		scr.input(4, 32, 20, "name", "", { bright: s.errField === "name" });
		label(scr, 4, 54, "TAX ===>");
		scr.input(4, 63, 1, "taxable", "", { bright: s.errField === "taxable" });
		scr.text(5, 2, "TYPE OVER A ROW TO CHANGE IT.  TAX: Y OR N.  ST: A=ACTIVE I=INACTIVE", { color: "blue" });

		const all = await listDepartments(ctx.env.DB);
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(all.length - rows, 0));
		const shown = all.slice(top, top + rows);
		s.top = top;
		s.total = all.length;
		s.keys = shown.map((d) => String(d.dept));
		scr.text(6, 2, "DEPT  NAME                  TAX  ST", { color: "white", bright: true });
		rule(scr, 7);
		if (all.length === 0) scr.text(FIRST, 2, "NO DEPARTMENTS YET - ADD ONE ON THE TOP LINE", { color: "blue" });
		shown.forEach((d, i) => {
			const row = FIRST + i;
			scr.text(row, 2, lpad(d.dept, 4), { color: "turquoise" });
			for (const [col, name, len, value] of [[8, "name", 20, d.name], [31, "tax", 1, yn(d.taxable)], [36, "st", 1, d.status]] as const) {
				const f = `${name}:${d.dept}`;
				scr.input(row, col, len, f, value, { bright: s.errField === f });
			}
		});
		if (all.length > 0) rowCount(scr, top, shown.length, all.length, 6);
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF7=UP  PF8=DOWN  ENTER=SAVE");
		scr.cursorTo(s.errField ?? "dept");
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
		const db = ctx.env.DB;
		let saved = 0;
		try {
			const dept = (inp.fields.dept ?? "").trim();
			if (dept) {
				await addDepartment(db, ctx.user, dept, inp.fields.name ?? "", inp.fields.taxable ?? "");
				// Added: if a row below is refused, the add line comes back blank.
				for (const f of ["dept", "name", "taxable"]) delete inp.fields[f];
				saved++;
			}
			for (const key of s.keys ?? []) {
				if (!["name", "tax", "st"].some((n) => inp.modified.has(`${n}:${key}`))) continue;
				try {
					await updateDepartment(db, ctx.user, Number(key), inp.fields[`name:${key}`] ?? "", inp.fields[`tax:${key}`] ?? "", inp.fields[`st:${key}`] ?? "");
				} catch (e) {
					// Point at the field in the row that was wrong.
					if (e instanceof Invalid) throw new Invalid(`${{ name: "name", taxable: "tax", status: "st" }[e.field] ?? "name"}:${key}`, `DEPARTMENT ${key}: ${e.message}`);
					throw e;
				}
				saved++;
			}
		} catch (e) {
			return refused(ctx, s, inp, e, "0201");
		}
		if (saved > 0) s.msg = `${msgId(ctx, "0202I")} ${saved} DEPARTMENT(S) SAVED`;
		return s;
	},
}));
