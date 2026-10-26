// The primary option menu, as ISPF does it, showing each person only the
// options their role allows. The numbering follows the back-office plan, so
// options keep their numbers as the later ones are built.

import { logoff, menuProgram, type Menus, type Option, type Program, type MenuState, type Value, type PanelState } from "@greenscreen-dev/worker";
import { can, who, type Right, type Who } from "../access";
import type { Env } from "../env";
import type { PosCtx } from "./types";

type Opt = Option<Env> & { right?: Right };

const go = (p: string) => (_ctx: PosCtx, back: MenuState) => ({ p, back });

const ALL: Record<string, { map: string; title: string; options: Opt[]; hint?: string[] }> = {
	"": {
		map: "POSM00",
		title: "BACK OFFICE",
		options: [
			{ key: "1", name: "PRODUCTS", desc: "Items, depts, prices", aliases: ["P"], sub: "1" },
			{ key: "4", name: "EMPLOYEES", desc: "People and roles", aliases: ["E"], right: "employees", go: go("employees") },
			{ key: "8", name: "ADMIN", desc: "Stores and registers", aliases: ["A"], sub: "8" },
			{ key: "R", name: "REGISTER", desc: "Run a register on this terminal", right: "register", go: go("lane") },
			{ key: "X", name: "EXIT", desc: "Log off", go: (ctx) => logoff(ctx) },
		],
	},
	"1": {
		map: "POSM01",
		title: "PRODUCTS",
		options: [
			{ key: "1", name: "ITEMS", desc: "The item master", aliases: ["I"], right: "items", go: go("items") },
			{ key: "2", name: "DEPTS", desc: "Departments", aliases: ["D"], right: "items", go: go("depts") },
			{ key: "3", name: "PRICES", desc: "Store price books", aliases: ["PB"], right: "prices", go: go("prices") },
		],
	},
	"8": {
		map: "POSM08",
		title: "STORES AND ADMIN",
		options: [
			{ key: "1", name: "STORES", desc: "Stores and receipts", aliases: ["S"], right: "stores", go: go("stores") },
			{ key: "2", name: "REGISTERS", desc: "Registers by store", aliases: ["R"], right: "stores", go: go("registers") },
		],
	},
};

// menusFor keeps the options a person may use, and the submenus that still
// have any.
function menusFor(w: Who | undefined): Menus<Env> {
	const out: Menus<Env> = {};
	for (const [k, m] of Object.entries(ALL)) {
		const options = m.options.filter((o) => !o.right || can(w, o.right));
		if (k === "" || options.length > 0) out[k] = { ...m, options };
	}
	out[""] = { ...out[""], options: out[""].options.filter((o) => !o.sub || out[o.sub]) };
	return out;
}

// One menu program for each set of rights, made when first needed.
const built = new Map<string, ReturnType<typeof menuProgram<Env>>>();

async function menuOf(ctx: PosCtx) {
	const w = await who(ctx);
	const rights = (["items", "prices", "stores", "employees", "register"] as const).filter((r) => can(w, r));
	const key = rights.join(",");
	let m = built.get(key);
	if (!m) {
		m = menuProgram<Env>(menusFor(w));
		built.set(key, m);
	}
	return m;
}

export const menu: Program<MenuState, Env> & { values(ctx: PosCtx, s: PanelState): Promise<Value[]> } = {
	async render(ctx, s) {
		return (await menuOf(ctx)).render(ctx, s);
	},
	async handle(ctx, s, inp) {
		return (await menuOf(ctx)).handle(ctx, s, inp);
	},
	async values(ctx, s) {
		return (await menuOf(ctx)).values(s);
	},
};
