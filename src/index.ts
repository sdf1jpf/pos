// Greenscreen POS: a multi-store point of sale and back office on
// Cloudflare Workers and D1. Every screen is a panel in src/screens; the
// data they keep is in src/data; @greenscreen-dev/worker does the rest.

import { accessAuth, createApp, helpTable, msgId, time, user, userIdFor, values } from "@greenscreen-dev/worker";
import { tso } from "@greenscreen-dev/worker/sessions";
import { who } from "./access";
import { listDepartments } from "./data/items";
import { reasons, type Kind } from "./data/reasons";
import { REPORTS } from "./data/reports";
import { registerForToken } from "./data/register";
import type { Env } from "./env";
import { signOn } from "./register/common";
import { closedrawer, functions, paid } from "./register/drawer";
import { approve, discount } from "./register/discount";
import { customer, gift, resumePanel } from "./register/extras";
import { receiptPanel, receipts } from "./register/receipt";
import { returnPanel } from "./register/returns";
import { card, sale, tender } from "./register/sale";
import { laneSelect, opendrawer, signon } from "./register/signon";
import { audit, auditRow, reasonCodes } from "./screens/audit";
import { customer as customerScreen, customers, giftcard } from "./screens/customers";
import { depts } from "./screens/depts";
import { employee, employees } from "./screens/employees";
import { closeDay, days, zreport } from "./screens/endofday";
import { adjustStock, count, counts, stock, stockLedger, transfer, transfers } from "./screens/inventory";
import { item, items } from "./screens/items";
import { menu } from "./screens/menu";
import { prices } from "./screens/prices";
import { report, reportPdf, reports } from "./screens/reports";
import { po, pos, reorder, suggested, vendor, vendorReturn, vendors } from "./screens/purchasing";
import { coupon, coupons, promotion, promotions } from "./screens/promos";
import { registers, store, stores } from "./screens/stores";
import { schedule, timecard, timecards } from "./screens/timeclock";

export type { Env };

const yesNo = values(["Y", "YES"], ["N", "NO"]);

const app = createApp<Env>({
	app: {
		title: "POINT OF SALE",
		prefix: "POS",
		system: "POS1",
		banner: ["GREENSCREEN POINT OF SALE", "BACK OFFICE"],
	},
	programs: {
		menu, items, item, depts, prices, promotions, promotion, coupons, coupon, stores, store, registers, employees, employee,
		stock, ledger: stockLedger, adjust: adjustStock, counts, count, transfers, transfer,
		vendors, vendor, pos, po, suggested, reorder, vreturn: vendorReturn, closeday: closeDay, days, zreport, timecards, timecard, schedule,
		customers, custfile: customerScreen, giftcard, audit, auditrow: auditRow, reasons: reasonCodes, reports, report,
		lane: laneSelect, signon, opendrawer, sale, tender, card, receipt: receiptPanel, receipts, functions, paid, closedrawer, approve, discount,
		return: returnPanel, customer, gift, resume: resumePanel,
	},
	// People sign on through Cloudflare Access as their userid. A register
	// signs on with its own service token, as the token's client ID.
	auth: accessAuth<Env>((claims) => (claims.email ? userIdFor(claims) : (claims.common_name ?? "SERVICE").toLowerCase())),
	// A register enrolled with its service token goes to its sign-on screen.
	// Otherwise only people on the employee file (or in ADMIN_USERS) get past
	// logon, to the back office.
	async start(ctx) {
		const reg = await registerForToken(ctx.env.DB, ctx.user);
		if (reg) return signOn(reg.store, reg.reg, "device");
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
		"promotion.kind": {
			title: "KIND",
			lines: ["What the promotion does to the items it names."],
			values: values(["SALE", "EACH (OR POUND) AT THE PRICE"], ["BOGO", "BUY QTY, GET MORE AT A PERCENT OFF"], ["MIX", "ANY QTY OF THE ITEMS FOR THE PRICE"]),
		},
		"promotion.items": { title: "ITEMS", lines: ["The SKUs on promotion, separated by commas. A line takes at most", "one promotion, and none once its price is overridden or discounted."] },
		"coupon.value": { title: "VALUE", lines: ["A percent off (10%) or an amount off (2.00), from the item, the", "department's items, or the whole sale."] },
		"discount.disc": { title: "DISCOUNT", lines: ["A percent (10%) or an amount (2.00) off the line, or a percent off", "the whole sale with LINE blank. 0 takes a discount off. Over the", "store's limit, a supervisor or manager approves it."] },
		"employee.pin": { title: "REGISTER PIN", lines: ["Four digits the person keys with their operator ID to sign on at a", "register or approve an override. Setting one unlocks someone locked", "out after three wrong PINs. Blank leaves the PIN as it is."] },
		"lane.store": { title: "STORE", lines: ["The store whose register to run on this terminal."] },
		"lane.reg": { title: "REGISTER", lines: ["The register to run. Its sales go in its own drawer."] },
		"signon.operator": { title: "OPERATOR ID", lines: ["The number on your employee record, 3 to 6 digits.", "Enter signs on; PF9 clocks you in, or out if you are on the clock."] },
		"customers.q": { title: "SEARCH", lines: ["A word in the customer's name, or any part of their phone number.", "Blank lists everyone."] },
		"custfile.phone": { title: "PHONE", lines: ["Ten digits. The register finds a customer by it, so no two", "customers share one."] },
		"custfile.exempt": { title: "TAX EXEMPT", lines: ["Y if the customer's purchases carry no sales tax. Key their", "certificate number too."], values: yesNo },
		"custfile.status": { title: "STATUS", lines: ["An inactive customer isn't found at the register."], values: values(["A", "ACTIVE"], ["I", "INACTIVE"]) },
		"giftcard.card": { title: "CARD NUMBER", lines: ["A gift card's 8 to 19 digits, or a store credit number: SC and", "12 digits, as printed on the receipt."] },
		"giftcard.amount": { title: "ADJUST", lines: ["An amount to add to the balance, e.g. 5.00, or to take off,", "e.g. -5.00. Needs a reason code."] },
		"audit.action": { title: "ACTION", lines: ["The start of the action: TIME shows every time clock entry,", "SALE.VOID only post-voids. Blank shows everything."] },
		"audit.before": { title: "ON OR BEFORE", lines: ["Show what happened on or before this day, YYYY-MM-DD.", "Blank is up to now."] },
		"reports.report": { title: "REPORT", lines: ["The report to show."], values: values(...Object.entries(REPORTS)) },
		"reports.from": { title: "FROM", lines: ["The first business day to report on, YYYY-MM-DD. A day's sales are", "those rung in drawers opened on it, as on its Z report."] },
		"reasons.kind": { title: "KIND", lines: ["Which reasons to keep."], values: values(["ADJUST", "STOCK ADJUSTMENTS"], ["OVERRIDE", "PRICE OVERRIDES"], ["CARD", "GIFT CARD CHANGES"]) },
		"timecards.week": { title: "WEEK OF", lines: ["Any day of the week to show, YYYY-MM-DD. Weeks run Monday to Sunday."] },
		"timecard.reason": { title: "REASON", lines: ["Why the punches are being changed. It is kept with each punch", "changed and in the audit log."] },
		"schedule.week": { title: "WEEK OF", lines: ["Any day of the week to schedule, YYYY-MM-DD. Weeks run Monday to Sunday."] },
		"schedule.sh": { title: "SHIFT", lines: ["Start and end, local time: 0900-1700, 9-17 or 9:30-17:30.", "A shift that ends before it starts ends the next day. Blank is a day off."] },
		"sale.item": { title: "ITEM", lines: ["Scan the barcode, or key the SKU or UPC, and press Enter.", "PF2 shows the price without ringing it."] },
		"sale.qty": { title: "QTY", lines: ["How many, 1 to 999; blank is 1. For an item sold by weight, the", "pounds from the scale, e.g. 1.25."] },
		"sale.line": { title: "LINE", lines: ["The line number to void with PF6. Blank voids the last line."] },
		"tender.method": { title: "METHOD", lines: ["How the customer pays this part."], values: values(["C", "CASH"], ["D", "CARD, ON THE CARD TERMINAL"], ["K", "CHECK"], ["G", "GIFT CARD"], ["S", "STORE CREDIT"]) },
		"tender.ref": { title: "REFERENCE", lines: ["A check number, or a gift card or store credit number. Refunding", "to store credit, blank issues a new one. A card needs none: the card", "terminal gives its last 4 and approval code."] },
		"tender.amount": { title: "AMOUNT", lines: ["How much this part pays, or refunds. Cash may be more than is due:", "the change is shown. Nothing else pays more than is due."] },
		"functions.option": { title: "OPTION", lines: ["The register function to go to."], values: values(["1", "RECEIPTS"], ["2", "PAID IN"], ["3", "PAID OUT"], ["4", "NO SALE"], ["5", "CLOSE DRAWER"], ["6", "SIGN OFF"],
			["7", "CUSTOMER"], ["8", "RETURN"], ["9", "GIFT CARD"], ["10", "SUSPEND THE SALE"], ["11", "RESUME A SALE"]) },
		"return.receipt": { title: "RECEIPT", lines: ["Scan the receipt's barcode or key its number, e.g. 1-01-000123."] },
		"customer.phone": { title: "PHONE", lines: ["The customer's 10-digit phone number. Not on file, you're asked", "for their name to add them."] },
		"customer.exempt": { title: "TAX EXEMPT", lines: ["Y if the customer's purchases carry no sales tax. Key their", "certificate number too."], values: yesNo },
		"gift.card": { title: "CARD NUMBER", lines: ["Scan the gift card, or key its 8 to 19 digits."] },
		"gift.amount": { title: "AMOUNT", lines: ["What goes on the card: 5.00 to 500.00."] },
		"receipts.sel": { title: "SELECTION CODE", lines: ["S shows a receipt to reprint. V voids a paid sale; a supervisor or", "manager approves it with their PIN."], values: values(["S", "SHOW/REPRINT"], ["V", "VOID"]) },
		"adjust.reason": { title: "REASON", lines: ["Why on hand is changed. Option 8.4 keeps the codes."], values: (ctx) => reasonValues(ctx.env.DB, "ADJUST") },
		"discount.reason": { title: "REASON", lines: ["Why the price is overridden. Option 8.4 keeps the codes."], values: (ctx) => reasonValues(ctx.env.DB, "OVERRIDE") },
		"giftcard.reason": { title: "REASON", lines: ["Why the balance is changed. Option 8.4 keeps the codes."], values: (ctx) => reasonValues(ctx.env.DB, "CARD") },
		"adjust.qty": { title: "CHANGE", lines: ["How many more there are (5) or fewer (-5). Pounds for a weighed", "item, e.g. -1.25."] },
		"stock.sel": { title: "SELECTION CODE", lines: ["L shows the item's ledger; A adjusts its on hand."], values: values(["L", "LEDGER"], ["A", "ADJUST"]) },
		"counts.dept": { title: "DEPARTMENT", lines: ["PF5 starts a cycle count of this department's items. Blank counts", "every item."], values: async (ctx) => deptValues(ctx.env.DB) },
		"vendor.leadDays": { title: "LEAD TIME", lines: ["Days from ordering to delivery. Suggested orders cover sales over", "the lead time plus two weeks."] },
		"pos.sel": { title: "SELECTION CODE", lines: ["S shows a purchase order: to order a draft, or receive a delivery."], values: values(["S", "SHOW/RECEIVE"]) },
		"employee.stores": { title: "STORES", lines: ["The store numbers the person works at, separated by commas.", "Blank means every store."] },
	}),
	stateKey: (env) => env.STATE_KEY,
	// Sessions and record locks: a register runs on one terminal at a time.
	sessions: (env) => (env.SESSIONS ? tso(env.SESSIONS) : undefined),
});

// A report printed to PDF (PF10 on a report), for the signed-on user.
app.get("/v1/report.pdf", app.signedOn, (c) => reportPdf(c.env, user(c), new URL(c.req.url)));

async function reasonValues(db: D1Database, kind: Kind) {
	return Object.entries(await reasons(db, kind)).map(([code, desc]) => ({ code, desc }));
}

async function deptValues(db: D1Database) {
	return (await listDepartments(db)).filter((d) => d.status === "A").map((d) => ({ code: String(d.dept), desc: d.name }));
}

export default app;
