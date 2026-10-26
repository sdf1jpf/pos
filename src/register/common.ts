// What the register panels share: the lane line under the title, holding
// the register so one terminal at a time runs it, and starting a sale.

import { header, newScreen, pad, panel, type PanelState, type Program, type Screen } from "@greenscreen-dev/worker";
import { siteNo } from "../data/db";
import type { Lane } from "../data/register";
import type { Env } from "../env";
import type { PosCtx } from "../screens/types";
import type { SaleState, SignOnState } from "./types";

export const two = (n: number) => String(n).padStart(2, "0");

// The record lock that keeps a register to one terminal.
export const laneLock = (store: number, reg: number) => `REGISTER ${store}/${two(reg)}`;

type Held = PanelState & ({ lane: Lane } | { store: number; reg: number; via: Lane["via"] });

const where = (s: Held) => ("lane" in s ? s.lane : s);

// onLane makes a register panel hold its register. If the session lost it
// (it sat idle and another terminal took the register), it goes back to
// sign-on, or to the back office it came from.
export function onLane<S extends Held>(p: Program<S, Env>): Program<S, Env> {
	return panel<S, Env>({
		...p,
		locks: (s) => [laneLock(where(s).store, where(s).reg)],
		unlocked: (s) => {
			const via = where(s).via;
			if (via === "office") return { p: "menu" };
			if (via === "clerk") return { p: "clerklane", msg: `REGISTER ${where(s).reg} WAS TAKEN BY ANOTHER TERMINAL` };
			return signOn(where(s).store, where(s).reg, "device");
		},
	});
}

export function signOn(store: number, reg: number, via: Lane["via"], msg?: string): SignOnState {
	return { p: "signon", store, reg, via, ...(msg ? { msg } : {}) };
}

export function newSale(lane: Lane, msg?: string): SaleState {
	return { p: "sale", lane, token: crypto.randomUUID(), lines: [], tenders: [], coupons: [], ...(msg ? { msg } : {}) };
}

// laneScreen starts a register screen: the title, and on line 3 the store,
// register and operator.
export function laneScreen(ctx: PosCtx, map: string, title: string, lane: Pick<Lane, "store" | "reg"> & Partial<Lane>): Screen {
	const scr = newScreen(ctx, map);
	header(scr, ctx, title);
	scr.text(3, 2, `STORE ${lane.store}  REG ${two(lane.reg)}`, { color: "turquoise" });
	if (lane.op) scr.text(3, 20, pad(`OPERATOR ${lane.op} ${lane.name}`, 40), { color: "turquoise" });
	if (lane.drawer) scr.text(3, scr.cols - 13, `DRAWER ${siteNo(lane.drawer)}`.padStart(12), { color: "turquoise" });
	return scr;
}

// readQty reads a quantity: whole units, or pounds to three places for a
// weighed item, in thousandths.
export function readQty(s: string, weighed: boolean): number | undefined {
	const t = s.trim();
	if (weighed) {
		const m = /^(\d{1,3})?(?:\.(\d{1,3}))?$/.exec(t);
		if (!t || !m) return undefined;
		const q = Number(m[1] ?? "0") * 1000 + Number((m[2] ?? "").padEnd(3, "0") || "0");
		return q > 0 ? q : undefined;
	}
	if (!t) return 1000;
	return /^\d{1,3}$/.test(t) && Number(t) > 0 ? Number(t) * 1000 : undefined;
}

export const showQty = (qty: number, weighed: boolean) => (weighed ? `${(qty / 1000).toFixed(3)} LB` : String(qty / 1000));
