import { clock, invalidKey, keys, label, logoff, message, msgId, newScreen, header, panel, pf, withFill } from "@greenscreen-dev/worker";
import { canStore, who } from "../access";
import { checkPin } from "../data/pins";
import { laneAudit, openDrawer, openDrawerAt, registerInfo, type Lane } from "../data/register";
import { storeNumber } from "../data/stores";
import { hours, punch } from "../data/timeclock";
import type { Env } from "../env";
import { guarded } from "../screens/common";
import { laneScreen, newSale, onLane, signOn } from "./common";
import { countForm, readCountsInto } from "./drawer";
import type { LaneSelectState, OpenDrawerState, SignOnState } from "./types";

// POS200 OPEN A REGISTER: from the back office, a supervisor or manager
// picks a register to run on this terminal. A register enrolled as a
// device goes straight to sign-on instead.

export const laneSelect = guarded("register", panel<LaneSelectState, Env>({
	render(ctx, s) {
		const scr = newScreen(ctx, "POS200");
		header(scr, ctx, "OPEN A REGISTER");
		label(scr, 5, 2, "STORE ===>");
		scr.input(5, 13, 3, "store", "", { numeric: true, bright: s.errField === "store" });
		label(scr, 6, 2, "REG   ===>");
		scr.input(6, 13, 2, "reg", "", { numeric: true, bright: s.errField === "reg" });
		scr.text(8, 2, "THIS TERMINAL BECOMES THE REGISTER UNTIL ITS OPERATOR SIGNS OFF AND PF3", { color: "blue" });
		scr.text(9, 2, "IS PRESSED ON THE SIGN-ON SCREEN. ONE TERMINAL AT A TIME RUNS A REGISTER.", { color: "blue" });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  ENTER=OPEN");
		scr.cursorTo(s.errField ?? "store");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const typed = { store: (inp.fields.store ?? "").trim(), reg: (inp.fields.reg ?? "").trim() };
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: typed, cursor: field });
		};
		const store = storeNumber(typed.store);
		if (store === undefined) return fail("store", "2001E STORE MUST BE 1 TO 999");
		if (!canStore((await who(ctx))!, store)) return fail("store", `2002E YOU MAY NOT OPEN REGISTERS IN STORE ${store}`);
		if (!/^\d{1,2}$/.test(typed.reg)) return fail("reg", "2003E REGISTER MUST BE 1 TO 99");
		const r = await registerInfo(ctx.env.DB, store, Number(typed.reg));
		if (!r) return fail("reg", `2004E REGISTER ${typed.reg} NOT FOUND IN STORE ${store}`);
		if (r.status !== "A") return fail("reg", `2005E REGISTER ${typed.reg} IN STORE ${store} IS INACTIVE`);
		return signOn(store, r.reg, "office");
	},
}));

// POS210 REGISTER SIGN ON: operator ID and PIN. Three wrong PINs in a row
// lock the operator out. PF9 with the same ID and PIN is the time clock.

export const signon = onLane(panel<SignOnState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS210", "REGISTER SIGN ON", s);
		const r = await registerInfo(ctx.env.DB, s.store, s.reg);
		scr.text(3, 20, `${r?.storeName ?? ""}  ${r?.name ?? ""}`.trim(), { color: "turquoise" });
		scr.text(7, 22, "KEY YOUR OPERATOR ID AND PIN", { color: "white", bright: true });
		label(scr, 9, 22, "OPERATOR ===>");
		scr.input(9, 36, 6, "operator", "", { numeric: true, bright: s.errField === "operator" });
		label(scr, 10, 22, "PIN      ===>");
		scr.input(10, 36, 4, "pin", "", { numeric: true, hidden: true, bright: s.errField === "pin" });
		message(scr, s.msg ?? "");
		keys(scr, `${s.via === "office" ? "PF3=BACK OFFICE" : "PF3=LOG OFF"}  PF9=CLOCK IN/OUT  ENTER=SIGN ON`);
		scr.cursorTo(s.errField ?? "operator");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3)) return s.via === "office" ? { p: "menu" } : logoff(ctx);
		if (inp.aid !== "ENTER" && inp.aid !== pf(9)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const operator = (inp.fields.operator ?? "").trim();
		const pin = (inp.fields.pin ?? "").trim();
		const fail = (field: string, msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = field;
			return withFill(s, { fields: { operator }, cursor: field });
		};
		if (!operator) return fail("operator", "2101E KEY YOUR OPERATOR ID");
		if (!pin) return fail("pin", "2102E KEY YOUR PIN");
		const r = await registerInfo(ctx.env.DB, s.store, s.reg);
		if (!r || r.status !== "A") return fail("operator", `2103E REGISTER ${s.reg} IS NOT IN USE - SEE A MANAGER`);
		const got = await checkPin(ctx.env.DB, s.store, operator, pin, s.reg);
		if (!got.ok) {
			switch (got.why) {
				case "badpin":
					return fail("pin", `2104E OPERATOR ID OR PIN IS WRONG - ${got.left} ${got.left === 1 ? "TRY" : "TRIES"} LEFT`);
				case "locked":
					return fail("operator", `2105E OPERATOR ${operator} IS LOCKED OUT - AN ADMINISTRATOR MUST SET A NEW PIN`);
				case "nopin":
					return fail("operator", `2106E OPERATOR ${operator} HAS NO PIN - SEE YOUR ADMINISTRATOR`);
				case "store":
					return fail("operator", `2107E OPERATOR ${operator} MAY NOT SIGN ON IN STORE ${s.store}`);
				default:
					return fail("operator", "2104E OPERATOR ID OR PIN IS WRONG");
			}
		}
		if (inp.aid === pf(9)) {
			// The time clock: in or out, and back to sign-on for the next person.
			const p = await punch(ctx.env.DB, got.op, s.store, s.reg);
			s.msg = p.kind === "in"
				? `${msgId(ctx, "2112I")} ${got.op.name} CLOCKED IN AT ${clock(ctx, p.at).slice(6, 11)}`
				: `${msgId(ctx, "2113I")} ${got.op.name} CLOCKED OUT AT ${clock(ctx, p.at).slice(6, 11)} - ${hours(p.minutes)} HOURS`;
			return s;
		}
		const lane: Lane = { store: s.store, reg: s.reg, emp: got.op.emp, op: got.op.operator, name: got.op.name, via: s.via };
		await laneAudit(ctx.env.DB, lane, "REG.SIGNON", s.via === "office" ? `from back office by ${ctx.user}` : "");
		const drawer = await openDrawerAt(ctx.env.DB, s.store, s.reg);
		if (!drawer) return { p: "opendrawer", lane, counts: {}, msg: `${msgId(ctx, "2108I")} NO DRAWER IS OPEN - COUNT THE FLOAT IN` } satisfies OpenDrawerState;
		lane.drawer = drawer.id;
		return newSale(lane, `${msgId(ctx, "2109I")} ${got.op.name} SIGNED ON`);
	},
}));

// POS211 OPEN DRAWER: the float counted into the drawer, by denomination.
// Enter adds it up; PF10 opens the drawer with it.

export const opendrawer = onLane(panel<OpenDrawerState, Env>({
	render(ctx, s) {
		const scr = laneScreen(ctx, "POS211", "OPEN DRAWER", s.lane);
		scr.text(5, 2, "COUNT THE FLOAT INTO THE DRAWER: HOW MANY OF EACH BILL AND COIN.", { color: "blue" });
		countForm(scr, 7, s.counts, s.errField);
		message(scr, s.msg ?? "");
		keys(scr, "PF3=SIGN OFF  PF10=OPEN DRAWER  ENTER=ADD UP");
		scr.cursorTo(s.errField ?? "n:100");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3)) {
			await laneAudit(ctx.env.DB, s.lane, "REG.SIGNOFF");
			return signOn(s.lane.store, s.lane.reg, s.lane.via, `${msgId(ctx, "2110I")} ${s.lane.name} SIGNED OFF`);
		}
		if (inp.aid !== "ENTER" && inp.aid !== pf(10)) {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		if (!readCountsInto(ctx, s, inp)) return s;
		if (inp.aid === "ENTER") return s;
		const drawer = await openDrawer(ctx.env.DB, s.lane, s.counts);
		return newSale({ ...s.lane, drawer }, `${msgId(ctx, "2111I")} DRAWER ${drawer} OPENED`);
	},
}));
