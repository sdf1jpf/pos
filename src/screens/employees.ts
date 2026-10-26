import { clock, dots, header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf } from "@greenscreen-dev/worker";
import { addEmployee, getEmployee, listEmployees, updateEmployee, type EmployeeInput } from "../data/employees";
import { pinState, setPin, validPin } from "../data/pins";
import type { Env } from "../env";
import { Invalid } from "../data/db";
import { FIELD_COL, FIRST, form, guarded, listRows, pick, refused, rowCount, rule, scroll, selected } from "./common";
import type { EmployeesState, EmployeeState } from "./types";

// POS410 EMPLOYEES: everyone on file, by name. S beside one shows them for
// update; PF5 adds one.

export const employees = guarded("employees", panel<EmployeesState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS410");
		header(scr, ctx, "EMPLOYEES");
		scr.text(5, 2, "SELECT: S=SHOW/UPDATE", { color: "blue" });
		const rows = listRows(ctx);
		const { employees, total } = await listEmployees(ctx.env.DB, s.top ?? 0, rows);
		s.keys = employees.map((e) => String(e.emp));
		s.total = total;
		rowCount(scr, s.top ?? 0, employees.length, total);
		scr.text(6, 2, "S   EMP  NAME                           ROLE        USERID   OPER    STORES  ST", { color: "white", bright: true });
		rule(scr, 7);
		if (total === 0) scr.text(FIRST, 4, "NO EMPLOYEES YET - PF5 TO ADD ONE", { color: "blue" });
		employees.forEach((e, i) => {
			const row = FIRST + i;
			const sel = `sel:${e.emp}`;
			scr.input(row, 2, 1, sel, "", { bright: s.errSel === sel });
			scr.text(row, 4, lpad(e.emp, 5), { color: "turquoise" });
			scr.text(row, 11, pad(e.name, 30), { color: "green" });
			scr.text(row, 42, pad(e.role, 11), { color: "green" });
			scr.text(row, 54, pad(e.userid, 8), { color: "green" });
			scr.text(row, 63, pad(e.operator, 6), { color: "green" });
			scr.text(row, 71, pad(e.stores.length ? e.stores.join(",") : "ALL", 7), { color: "green" });
			scr.text(row, 79, e.status, { color: e.status === "A" ? "green" : "yellow" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN");
		if (employees.length > 0) scr.cursorTo(`sel:${employees[0].emp}`);
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
				return { p: "employee", back: s } satisfies EmployeeState;
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}
		for (const x of selected(inp, s.keys ?? [])) {
			if (x.code !== "S") {
				s.msg = `${msgId(ctx, "0401E")} INVALID SELECTION CODE "${x.code}" - TYPE S`;
				s.errSel = x.field;
				return s;
			}
			return { p: "employee", back: s, emp: Number(x.key) } satisfies EmployeeState;
		}
		return s;
	},
}));

// POS411 EMPLOYEE: one person, to add or update. PF1 in ROLE lists the roles.

const FIELDS = ["name", "role", "userid", "operator", "status", "stores"] as const;

export const employee = guarded("employees", panel<EmployeeState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS411");
		const e = s.emp !== undefined ? await getEmployee(ctx.env.DB, s.emp) : undefined;
		header(scr, ctx, e ? `EMPLOYEE ${e.emp}` : "ADD EMPLOYEE");
		if (s.emp !== undefined && !e) {
			message(scr, `${msgId(ctx, "0402E")} EMPLOYEE ${s.emp} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		if (e) s.version ??= e.version;
		form(scr, [
			{ row: 4, label: "NAME", name: "name", len: 30, value: e?.name ?? "" },
			{ row: 5, label: "ROLE", name: "role", len: 10, value: e?.role ?? "CASHIER", note: "PF1 LISTS THE ROLES" },
			{ row: 7, label: "USERID", name: "userid", len: 8, value: e?.userid ?? "", note: "BACK-OFFICE SIGN-ON; BLANK IF NONE" },
			{ row: 8, label: "OPERATOR ID", name: "operator", len: 6, value: e?.operator ?? "", numeric: true, note: "KEYED AT THE REGISTER; 3 TO 6 DIGITS" },
			{ row: 9, label: "STORES", name: "stores", len: 30, value: e?.stores.join(",") ?? "", note: "E.G. 1,3; BLANK FOR ALL" },
			{ row: 10, label: "STATUS", name: "status", len: 1, value: e?.status ?? "A", note: "A=ACTIVE  I=INACTIVE" },
		], s.errField);
		const pin = e ? await pinState(ctx.env.DB, e.emp) : "NONE";
		label(scr, 11, 2, dots("REGISTER PIN", FIELD_COL - 3));
		scr.input(11, FIELD_COL, 4, "pin", "", { hidden: true, numeric: true, bright: s.errField === "pin" });
		scr.text(11, FIELD_COL + 6, { NONE: "NONE SET", SET: "SET", LOCKED: "LOCKED OUT" }[pin] + " - 4 DIGITS SETS A NEW ONE", {
			color: pin === "LOCKED" ? "yellow" : "blue",
		});
		scr.text(13, 2, "THE USERID IS THE PART OF THE PERSON'S EMAIL BEFORE THE @,", { color: "blue" });
		scr.text(14, 2, "LETTERS AND DIGITS ONLY, AT MOST 8 CHARACTERS: JANE.DOE@ BECOMES JANEDOE.", { color: "blue" });
		if (e) scr.text(16, 2, `LAST CHANGED ${clock(ctx, e.updatedAt)} BY ${e.updatedBy}   VERSION ${e.version}`, { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, `PF1=HELP  PF3=RETURN  ENTER=${e ? "UPDATE" : "ADD"}`);
		scr.cursorTo(s.errField ?? "name");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed: EmployeeInput = pick(inp, FIELDS);
		const pin = (inp.fields.pin ?? "").trim();
		try {
			if (pin && !validPin(pin)) throw new Invalid("pin", "PIN MUST BE 4 DIGITS");
			if (s.emp !== undefined) {
				const e = await updateEmployee(ctx.env.DB, ctx.user, s.emp, s.version ?? 0, typed);
				s.version = e.version;
				s.msg = `${msgId(ctx, "0403I")} EMPLOYEE ${e.emp} UPDATED`;
				if (pin) await setPin(ctx.env.DB, ctx.user, e.emp, pin);
			} else {
				const e = await addEmployee(ctx.env.DB, ctx.user, typed);
				s.emp = e.emp;
				s.version = e.version;
				s.msg = `${msgId(ctx, "0404I")} EMPLOYEE ${e.emp} ADDED`;
				if (pin) await setPin(ctx.env.DB, ctx.user, e.emp, pin);
			}
			return s;
		} catch (e) {
			return refused(ctx, s, inp, e, "0405");
		}
	},
}));
