// Greenscreen POS: a multi-store point of sale and back office on
// Cloudflare Workers and D1. Every screen is a panel in src/screens; the
// data they keep is in src/data; @greenscreen-dev/worker does the rest.

import { createApp, helpTable, msgId, time, values } from "@greenscreen-dev/worker";
import { who } from "./access";
import { listDepartments } from "./data/items";
import type { Env } from "./env";
import { depts } from "./screens/depts";
import { employee, employees } from "./screens/employees";
import { item, items } from "./screens/items";
import { menu } from "./screens/menu";
import { prices } from "./screens/prices";
import { registers, store, stores } from "./screens/stores";

export type { Env };

const yesNo = values(["Y", "YES"], ["N", "NO"]);

const app = createApp<Env>({
	app: {
		title: "POINT OF SALE",
		prefix: "POS",
		system: "POS1",
		banner: ["GREENSCREEN POINT OF SALE", "BACK OFFICE"],
	},
	programs: { menu, items, item, depts, prices, stores, store, registers, employees, employee },
	// Only people on the employee file (or in ADMIN_USERS) get past logon.
	async start(ctx) {
		if (!(await who(ctx))) {
			return { logoff: `${msgId(ctx, "0001E")} ${ctx.user} IS NOT AUTHORIZED FOR THE BACK OFFICE - SEE YOUR ADMINISTRATOR` };
		}
		return { p: "menu", msg: `IKJ56455I ${ctx.user} LOGON IN PROGRESS AT ${time(ctx)}` };
	},
	fieldHelp: helpTable<Env>({
		"menu.option": { title: "OPTION", lines: ["The menu option to go to."], values: (ctx, s) => menu.values(ctx, s) },
		"items.q": { title: "SEARCH", lines: ["A SKU or UPC, the start of a SKU, or a word in the description.", "Blank lists every item."] },
		"items.dept": { title: "DEPARTMENT", lines: ["Only items in this department. Blank for all."], values: async (ctx) => deptValues(ctx.env.DB) },
		"items.sel": { title: "SELECTION CODE", lines: ["Type S beside an item and press Enter to show it."], values: values(["S", "SHOW/UPDATE"]) },
		"item.sku": { title: "SKU", lines: ["The item's code: up to 14 letters, digits or dashes. It can't be", "changed once the item is added."] },
		"item.upc": { title: "UPC", lines: ["The barcode number, 8 to 14 digits, or blank. Scanning it at the", "register finds the item."] },
		"item.dept": { title: "DEPARTMENT", lines: ["The item's department."], values: async (ctx) => deptValues(ctx.env.DB) },
		"item.class": { title: "CLASS", lines: ["A code of up to 4 characters to group items within a department."] },
		"item.vendor": { title: "VENDOR", lines: ["The code of the vendor the item is bought from."] },
		"item.cost": { title: "COST", lines: ["What one unit (or pound) costs, in dollars and cents."] },
		"item.price": { title: "BASE PRICE", lines: ["What it sells for at any store without a price of its own in the", "price book (option 1.3). Per pound for a weighed item."] },
		"item.taxable": { title: "TAXABLE", lines: ["Y if sales tax is charged. Blank takes the department's setting."], values: yesNo },
		"item.weighed": { title: "WEIGHED", lines: ["Y if the item is sold by the pound: the cashier keys its weight."], values: yesNo },
		"item.status": { title: "STATUS", lines: ["A discontinued item can't be sold."], values: values(["A", "ACTIVE"], ["D", "DISCONTINUED"]) },
		"prices.store": { title: "STORE", lines: ["The store whose price book to show."] },
		"employee.role": {
			title: "ROLE",
			lines: ["What the person may do. Back-office menus show only what their role", "allows."],
			values: values(
				["CASHIER", "SELLS AT THE REGISTER; NO BACK OFFICE"],
				["SUPERVISOR", "REGISTER OVERRIDES"],
				["MANAGER", "A STORE: ITS PRICE BOOK, DRAWERS, END OF DAY"],
				["BUYER", "ITEMS, DEPARTMENTS AND PRICES"],
				["ADMIN", "EVERYTHING, INCLUDING STORES AND EMPLOYEES"],
			),
		},
		"employee.stores": { title: "STORES", lines: ["The store numbers the person works at, separated by commas.", "Blank means every store."] },
	}),
	stateKey: (env) => env.STATE_KEY,
});

async function deptValues(db: D1Database) {
	return (await listDepartments(db)).filter((d) => d.status === "A").map((d) => ({ code: String(d.dept), desc: d.name }));
}

export default app;
