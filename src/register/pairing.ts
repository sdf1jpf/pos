import { clock, invalidKey, keys, label, message, msgId, panel, pf, withFill } from "@greenscreen-dev/worker";
import { pair, pairedTo, unpair } from "../data/displays";
import { laneAudit } from "../data/register";
import { displayFor } from "../display";
import type { Env } from "../env";
import { laneScreen, onLane } from "./common";
import type { DisplayState } from "./types";

// POS238 CUSTOMER DISPLAY: pairs a customer display (a tablet or second
// monitor showing /display) to this register, by the code it shows. PF6
// unpairs the register's displays; they go back to showing a code.

export const pairDisplay = onLane(panel<DisplayState, Env>({
	async render(ctx, s) {
		const scr = laneScreen(ctx, "POS238", "CUSTOMER DISPLAY", s.lane);
		scr.text(5, 2, "OPEN /display ON THE SCREEN FACING THE CUSTOMER. IT SHOWS A 6-DIGIT CODE:", { color: "blue" });
		scr.text(6, 2, "KEY IT HERE AND PRESS ENTER. THE DISPLAY THEN SHOWS EACH SALE AS IT IS RUNG.", { color: "blue" });
		label(scr, 8, 2, "CODE ===>");
		scr.input(8, 12, 6, "code", "", { numeric: true, bright: s.errField === "code" });
		const shown = await pairedTo(ctx.env.DB, s.lane.store, s.lane.reg);
		scr.text(10, 2, shown.length ? `DISPLAYS PAIRED TO THIS REGISTER: ${shown.length}` : "NO DISPLAY IS PAIRED TO THIS REGISTER", { color: "white", bright: true });
		shown.slice(0, 8).forEach((d, i) => scr.text(11 + i, 4, `PAIRED ${clock(ctx, d.pairedAt)} BY ${d.pairedBy}`, { color: "turquoise" }));
		message(scr, s.msg ?? "");
		keys(scr, `PF3=RETURN TO SALE  ENTER=PAIR${shown.length ? "  PF6=UNPAIR ALL" : ""}`);
		scr.cursorTo("code");
		return scr;
	},
	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		const { store, reg } = s.lane;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid === pf(6)) {
			const gone = await unpair(ctx.env.DB, store, reg);
			if (gone.length === 0) {
				s.msg = `${msgId(ctx, "2383E")} NO DISPLAY IS PAIRED TO THIS REGISTER`;
				return s;
			}
			await displayFor(ctx.env, store, reg)?.drop(gone);
			await laneAudit(ctx.env.DB, s.lane, "REG.DISPLAY.UNPAIR", `${gone.length}`);
			s.msg = `${msgId(ctx, "2384I")} ${gone.length} DISPLAY${gone.length > 1 ? "S" : ""} UNPAIRED`;
			return s;
		}
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const code = (inp.fields.code ?? "").trim();
		const fail = (msg: string) => {
			s.msg = msgId(ctx, msg);
			s.errField = "code";
			return withFill(s, { fields: inp.fields, cursor: "code" });
		};
		if (!/^\d{6}$/.test(code)) return fail("2381E KEY THE 6-DIGIT CODE THE DISPLAY SHOWS");
		if (!(await pair(ctx.env.DB, code, store, reg, s.lane.name))) return fail(`2382E NO DISPLAY IS SHOWING ${code} - CHECK IT, OR RELOAD THE DISPLAY FOR A NEW ONE`);
		await laneAudit(ctx.env.DB, s.lane, "REG.DISPLAY.PAIR");
		return { ...s.back, msg: `${msgId(ctx, "2380I")} CUSTOMER DISPLAY PAIRED TO REGISTER ${reg}` };
	},
}));
