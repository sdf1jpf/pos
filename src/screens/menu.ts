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
			{ key: "2", name: "INVENTORY", desc: "On hand, counts, transfers", aliases: ["IN"], sub: "2" },
			{ key: "3", name: "PURCHASING", desc: "Vendors, orders, receiving", aliases: ["PU"], sub: "3" },
			{ key: "4", name: "EMPLOYEES", desc: "People and roles", aliases: ["E"], right: "employees", go: go("employees") },
			{ key: "5", name: "END OF DAY", desc: "Close the day, Z reports", aliases: ["EOD"], sub: "5" },
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
			{ key: "4", name: "PROMOTIONS", desc: "Sale prices, BOGOs, mix and match", aliases: ["PR"], right: "items", go: go("promotions") },
			{ key: "5", name: "COUPONS", desc: "Coupons the registers take", aliases: ["C"], right: "items", go: go("coupons") },
		],
	},
	"2": {
		map: "POSM02",
		title: "INVENTORY",
		options: [
			{ key: "1", name: "ON HAND", desc: "Stock by store, and its ledger", aliases: ["OH"], right: "inventory", go: go("stock") },
			{ key: "2", name: "ADJUST", desc: "Damage, shrink, found", aliases: ["A"], right: "inventory", go: (_ctx, back) => ({ p: "adjust", back, token: crypto.randomUUID() }) },
			{ key: "3", name: "COUNTS", desc: "Cycle and full counts", aliases: ["C"], right: "inventory", go: go("counts") },
			{ key: "4", name: "TRANSFERS", desc: "Stock sent between stores", aliases: ["T"], right: "inventory", go: go("transfers") },
		],
	},
	"3": {
		map: "POSM03",
		title: "PURCHASING",
		options: [
			{ key: "1", name: "VENDORS", desc: "The vendor file", aliases: ["V"], right: "items", go: go("vendors") },
			{ key: "2", name: "ORDERS", desc: "Purchase orders and receiving", aliases: ["PO", "R"], right: "purchasing", go: go("pos") },
			{ key: "3", name: "SUGGESTED", desc: "What to order, by vendor", aliases: ["S"], right: "purchasing", go: (_ctx, back) => ({ p: "suggested", back }) },
			{ key: "4", name: "REORDER", desc: "Min and max by store", aliases: ["MM"], right: "purchasing", go: go("reorder") },
			{ key: "5", name: "RETURNS", desc: "Stock back to a vendor", aliases: ["RV"], right: "purchasing", go: (_ctx, back) => ({ p: "vreturn", back, token: crypto.randomUUID() }) },
		],
	},
	"5": {
		map: "POSM05",
		title: "END OF DAY",
		options: [
			{ key: "1", name: "CLOSE", desc: "Close the store's day", aliases: ["C"], right: "endofday", go: go("closeday") },
			{ key: "2", name: "DAYS", desc: "Closed days and Z reports", aliases: ["Z"], right: "endofday", go: go("days") },
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
	const rights = (["items", "prices", "inventory", "purchasing", "endofday", "stores", "employees", "register"] as const).filter((r) => can(w, r));
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
