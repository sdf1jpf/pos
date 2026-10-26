// Reports: sales and inventory, laid out as fixed-width text that the
// screen shows and the PDF prints alike. Sales count by business day (the
// day of the drawer they were rung in, as the Z report does), completed
// sales only, gift cards sold left out of merchandise.

import { dollars } from "../money";

export const WIDTH = 78;

export const REPORTS = {
	SD: "SALES BY DAY",
	SH: "SALES BY HOUR",
	SP: "SALES AND MARGIN BY DEPARTMENT",
	SI: "SALES AND MARGIN BY ITEM",
	SC: "SALES BY CASHIER",
	ST: "TENDERS",
	SX: "EXCEPTIONS: VOIDS, OVERRIDES, RETURNS",
	IV: "INVENTORY VALUE BY DEPARTMENT",
	IL: "LOW STOCK",
} as const;
export type ReportCode = keyof typeof REPORTS;
export const isReport = (s: string): s is ReportCode => s in REPORTS;
// The inventory reports are as of now; the rest cover a range of days.
export const dated = (r: ReportCode) => r !== "IV" && r !== "IL";

export interface ReportParams {
	report: ReportCode;
	stores: number[]; // none is every store
	from: string; // YYYY-MM-DD
	to: string;
	tz: number; // the reader's offset from UTC, in minutes, for hours
}

export interface Report {
	title: string;
	sub: string;
	head: string[];
	body: string[];
}

const r = (v: string | number, n: number) => String(v).padStart(n);
const l = (v: string | number, n: number) => String(v).slice(0, n).padEnd(n);
const money = (c: number, n: number) => r(dollars(c), n);
const qty = (t: number) => (t % 1000 === 0 ? String(t / 1000) : (t / 1000).toFixed(3));
const pct = (part: number, whole: number) => (whole ? `${((part * 100) / whole).toFixed(1)}%` : "");
const rule = "-".repeat(WIDTH);

// The SQL for the sales in range, with its arguments.
function salesIn(p: ReportParams, alias = "s"): { sql: string; args: (string | number)[] } {
	const st = p.stores.length ? ` AND store IN (${p.stores.map(() => "?").join(", ")})` : "";
	return { sql: `${alias}.drawer IN (SELECT id FROM drawers WHERE day >= ? AND day <= ?${st})`, args: [p.from, p.to, ...p.stores] };
}

// A line's cost: what the item cost when its sale was posted to the
// ledger, or what it costs now for one not posted yet.
const LINE_COST = "ROUND(COALESCE(l.cost, i.cost, 0) * l.qty / 1000.0)";
const LINE_NET = "COALESCE(l.net, l.amount)";

export async function runReport(db: D1Database, p: ReportParams): Promise<Report> {
	const where = p.stores.length ? `STORE${p.stores.length > 1 ? "S" : ""} ${p.stores.join(", ")}` : "ALL STORES";
	const sub = dated(p.report) ? `${where}   ${p.from === p.to ? p.from : `${p.from} TO ${p.to}`}` : `${where}   AS OF NOW`;
	const out: Report = { title: REPORTS[p.report], sub, head: [], body: [] };
	const s = salesIn(p);
	const all = async <T>(sql: string, args: (string | number)[]) => (await db.prepare(sql).bind(...args).all<T>()).results;

	switch (p.report) {
		case "SD": {
			type Row = { day: string; sales: number; total: number; tax: number; discounts: number; merch: number; returns: number };
			const rows = await all<Row>(`SELECT d.day, COUNT(*) AS sales, SUM(s.total) AS total, SUM(s.tax) AS tax, SUM(s.discount) AS discounts,
				COALESCE(SUM((SELECT SUM(${LINE_NET}) FROM sale_lines l WHERE l.sale = s.id AND l.voided = 0 AND l.card IS NULL AND l.qty > 0)), 0) AS merch,
				COALESCE(SUM((SELECT SUM(${LINE_NET}) FROM sale_lines l WHERE l.sale = s.id AND l.voided = 0 AND l.card IS NULL AND l.qty < 0)), 0) AS returns
				FROM sales s JOIN drawers d ON d.id = s.drawer WHERE s.status = 'C' AND ${s.sql} GROUP BY d.day ORDER BY d.day`, s.args);
			out.head = [`${l("DAY", 10)}${r("SALES", 7)}${r("MERCHANDISE", 13)}${r("RETURNS", 11)}${r("DISCOUNTS", 11)}${r("TAX", 10)}${r("TOTAL", 12)}`, rule];
			const t = { sales: 0, merch: 0, returns: 0, discounts: 0, tax: 0, total: 0 };
			for (const x of rows) {
				out.body.push(`${l(x.day, 10)}${r(x.sales, 7)}${money(x.merch, 13)}${money(x.returns, 11)}${money(x.discounts, 11)}${money(x.tax, 10)}${money(x.total, 12)}`);
				for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += x[k];
			}
			if (!rows.length) out.body.push("NO SALES");
			else out.body.push(rule, `${l("TOTAL", 10)}${r(t.sales, 7)}${money(t.merch, 13)}${money(t.returns, 11)}${money(t.discounts, 11)}${money(t.tax, 10)}${money(t.total, 12)}`,
				"", `AVERAGE SALE ${dollars(Math.round(t.total / t.sales))}`);
			break;
		}
		case "SH": {
			const shift = `${p.tz >= 0 ? "+" : ""}${p.tz} minutes`;
			const rows = await all<{ hour: string; sales: number; total: number }>(`SELECT strftime('%H', s.at, ?) AS hour, COUNT(*) AS sales, SUM(s.total) AS total
				FROM sales s WHERE s.status = 'C' AND ${s.sql} GROUP BY hour ORDER BY hour`, [shift, ...s.args]);
			const most = Math.max(...rows.map((x) => x.total), 1);
			out.head = [`${l("HOUR", 12)}${r("SALES", 7)}${r("TOTAL", 12)}${r("AVG", 9)}  ${"SHARE OF THE BUSIEST HOUR"}`, rule];
			for (const x of rows) {
				const h = Number(x.hour);
				const bar = "*".repeat(Math.round((x.total / most) * 34));
				out.body.push(`${l(`${String(h).padStart(2, "0")}:00-${String(h).padStart(2, "0")}:59`, 12)}${r(x.sales, 7)}${money(x.total, 12)}${money(Math.round(x.total / x.sales), 9)}  ${bar}`);
			}
			if (!rows.length) out.body.push("NO SALES");
			break;
		}
		case "SP":
		case "SI": {
			const byItem = p.report === "SI";
			type Row = { key: string; name: string; qty: number; net: number; cost: number };
			const rows = await all<Row>(`SELECT ${byItem ? "l.sku" : "l.dept"} AS key, ${byItem ? "MAX(l.descr)" : "COALESCE(dp.name, '')"} AS name,
				SUM(l.qty) AS qty, SUM(${LINE_NET}) AS net, SUM(${LINE_COST}) AS cost
				FROM sales s JOIN sale_lines l ON l.sale = s.id LEFT JOIN items i ON i.sku = l.sku LEFT JOIN departments dp ON dp.dept = l.dept
				WHERE s.status = 'C' AND l.voided = 0 AND l.card IS NULL AND ${s.sql}
				GROUP BY ${byItem ? "l.sku" : "l.dept"} ORDER BY ${byItem ? "net DESC" : "l.dept"} ${byItem ? "LIMIT 500" : ""}`, s.args);
			out.head = [`${l(byItem ? "ITEM" : "DEPT", byItem ? 14 : 5)} ${l("DESCRIPTION", byItem ? 20 : 29)}${r("QTY", 9)}${r("SALES", 11)}${r("COST", 11)}${r("MARGIN", 11)}${r("%", 6)}`, rule];
			const t = { net: 0, cost: 0 };
			for (const x of rows) {
				out.body.push(`${l(x.key, byItem ? 14 : 5)} ${l(x.name, byItem ? 20 : 29)}${r(qty(x.qty), 9)}${money(x.net, 11)}${money(x.cost, 11)}${money(x.net - x.cost, 11)}${r(pct(x.net - x.cost, x.net), 6)}`);
				t.net += x.net;
				t.cost += x.cost;
			}
			if (!rows.length) out.body.push("NO SALES");
			else out.body.push(rule, `${l("TOTAL", byItem ? 35 : 35)}${r("", 9)}${money(t.net, 11)}${money(t.cost, 11)}${money(t.net - t.cost, 11)}${r(pct(t.net - t.cost, t.net), 6)}`);
			if (byItem && rows.length === 500) out.body.push("", "THE 500 BEST SELLING ITEMS ARE SHOWN");
			break;
		}
		case "SC": {
			const rows = await all<{ operator: string; name: string; sales: number; total: number; voids: number; voided: number }>(
				`SELECT COALESCE(e.operator, '') AS operator, e.name, COUNT(CASE WHEN s.status = 'C' THEN 1 END) AS sales,
				COALESCE(SUM(CASE WHEN s.status = 'C' THEN s.total END), 0) AS total, COUNT(CASE WHEN s.status = 'V' THEN 1 END) AS voids,
				COALESCE(SUM(CASE WHEN s.status = 'V' THEN s.total END), 0) AS voided
				FROM sales s JOIN employees e ON e.emp = s.emp WHERE s.status IN ('C', 'V') AND ${s.sql} GROUP BY s.emp ORDER BY e.name`, s.args);
			out.head = [`${l("OPER", 7)}${l("NAME", 24)}${r("SALES", 7)}${r("TOTAL", 12)}${r("AVG", 9)}${r("VOIDS", 7)}${r("VOIDED", 11)}`, rule];
			for (const x of rows) {
				out.body.push(`${l(x.operator, 7)}${l(x.name, 24)}${r(x.sales, 7)}${money(x.total, 12)}${x.sales ? money(Math.round(x.total / x.sales), 9) : r("", 9)}${r(x.voids, 7)}${money(x.voided, 11)}`);
			}
			if (!rows.length) out.body.push("NO SALES");
			break;
		}
		case "ST": {
			const rows = await all<{ kind: string; n: number; amount: number; refunds: number }>(`SELECT t.kind, COUNT(*) AS n, SUM(t.amount) AS amount,
				SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) AS refunds
				FROM sales s JOIN sale_tenders t ON t.sale = s.id WHERE s.status = 'C' AND ${s.sql} GROUP BY t.kind ORDER BY amount DESC`, s.args);
			out.head = [`${l("TENDER", 16)}${r("COUNT", 7)}${r("TAKEN", 14)}${r("REFUNDED", 14)}${r("NET", 14)}${r("SHARE", 8)}`, rule];
			const total = rows.reduce((a, x) => a + x.amount, 0);
			for (const x of rows) {
				out.body.push(`${l(x.kind, 16)}${r(x.n, 7)}${money(x.amount - x.refunds, 14)}${money(x.refunds, 14)}${money(x.amount, 14)}${r(pct(x.amount, total), 8)}`);
			}
			if (!rows.length) out.body.push("NO SALES");
			else out.body.push(rule, `${l("TOTAL", 51)}${money(total, 14)}`);
			break;
		}
		case "SX": {
			const voids = await all<{ id: number; at: string; store: number; reg: number; total: number; op: string; by: string }>(
				`SELECT s.id, s.voided_at AS at, s.store, s.reg, s.total, COALESCE(e.operator, '') AS op, COALESCE(a.operator, '') AS by
				FROM sales s JOIN employees e ON e.emp = s.emp LEFT JOIN employees a ON a.emp = s.void_approver
				WHERE s.status = 'V' AND ${s.sql} ORDER BY s.id`, s.args);
			const overrides = await all<{ sale: number; sku: string; descr: string; orig: number; price: number; reason: string }>(
				`SELECT l.sale, l.sku, l.descr, l.orig_price AS orig, l.price, l.reason FROM sales s JOIN sale_lines l ON l.sale = s.id
				WHERE s.status = 'C' AND l.voided = 0 AND l.orig_price IS NOT NULL AND ${s.sql} ORDER BY l.sale, l.line`, s.args);
			const returns = await all<{ sale: number; sku: string; descr: string; qty: number; net: number }>(
				`SELECT l.sale, l.sku, l.descr, l.qty, ${LINE_NET} AS net FROM sales s JOIN sale_lines l ON l.sale = s.id
				WHERE s.status = 'C' AND l.voided = 0 AND l.qty < 0 AND l.ret_sale IS NULL AND ${s.sql} ORDER BY l.sale, l.line`, s.args);
			const disc = (await all<{ n: number; amount: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(s.discount), 0) AS amount
				FROM sales s WHERE s.status = 'C' AND s.discount <> 0 AND ${s.sql}`, s.args))[0];
			out.body.push(`POST-VOIDS: ${voids.length}`, `  ${l("SALE", 8)}${l("STORE/REG", 11)}${l("CASHIER", 9)}${l("APPROVED BY", 13)}${r("TOTAL", 12)}`);
			for (const x of voids) out.body.push(`  ${l(x.id, 8)}${l(`${x.store}/${String(x.reg).padStart(2, "0")}`, 11)}${l(x.op, 9)}${l(x.by, 13)}${money(x.total, 12)}`);
			out.body.push("", `PRICE OVERRIDES: ${overrides.length}`, `  ${l("SALE", 8)}${l("ITEM", 15)}${l("DESCRIPTION", 22)}${r("WAS", 10)}${r("NOW", 10)}  REASON`);
			for (const x of overrides) out.body.push(`  ${l(x.sale, 8)}${l(x.sku, 15)}${l(x.descr, 22)}${money(x.orig, 10)}${money(x.price, 10)}  ${x.reason}`);
			out.body.push("", `RETURNS WITHOUT A RECEIPT: ${returns.length}`, `  ${l("SALE", 8)}${l("ITEM", 15)}${l("DESCRIPTION", 30)}${r("QTY", 7)}${r("AMOUNT", 12)}`);
			for (const x of returns) out.body.push(`  ${l(x.sale, 8)}${l(x.sku, 15)}${l(x.descr, 30)}${r(qty(x.qty), 7)}${money(x.net, 12)}`);
			out.body.push("", `SALES WITH A DISCOUNT: ${disc.n}, ${dollars(disc.amount)} IN ALL`);
			break;
		}
		case "IV": {
			const st = p.stores.length ? `AND k.store IN (${p.stores.map(() => "?").join(", ")})` : "";
			const rows = await all<{ dept: number; name: string; items: number; units: number; cost: number; retail: number; negative: number }>(
				`SELECT i.dept, COALESCE(dp.name, '') AS name, COUNT(DISTINCT k.sku) AS items, SUM(k.on_hand) AS units,
				SUM(CASE WHEN k.on_hand > 0 THEN ROUND(k.on_hand * i.cost / 1000.0) ELSE 0 END) AS cost,
				SUM(CASE WHEN k.on_hand > 0 THEN ROUND(k.on_hand * i.price / 1000.0) ELSE 0 END) AS retail,
				COUNT(CASE WHEN k.on_hand < 0 THEN 1 END) AS negative
				FROM stock k JOIN items i ON i.sku = k.sku LEFT JOIN departments dp ON dp.dept = i.dept
				WHERE k.on_hand <> 0 ${st} GROUP BY i.dept ORDER BY i.dept`, p.stores);
			out.head = [`${l("DEPT", 5)} ${l("NAME", 22)}${r("ITEMS", 7)}${r("UNITS", 10)}${r("AT COST", 13)}${r("AT RETAIL", 13)}${r("NEG", 5)}`, rule];
			const t = { cost: 0, retail: 0, negative: 0 };
			for (const x of rows) {
				out.body.push(`${l(x.dept, 5)} ${l(x.name, 22)}${r(x.items, 7)}${r(qty(x.units), 10)}${money(x.cost, 13)}${money(x.retail, 13)}${r(x.negative || "", 5)}`);
				t.cost += x.cost;
				t.retail += x.retail;
				t.negative += x.negative;
			}
			if (!rows.length) out.body.push("NOTHING ON HAND");
			else out.body.push(rule, `${l("TOTAL", 45)}${money(t.cost, 13)}${money(t.retail, 13)}`);
			out.body.push("", "COST IS EACH ITEM'S AVERAGE COST; RETAIL IS ITS BASE PRICE.");
			if (t.negative) out.body.push(`${t.negative} ITEM(S) SHOW LESS THAN NOTHING ON HAND (NEG) AND ARE LEFT OUT - COUNT THEM.`);
			break;
		}
		case "IL": {
			const st = p.stores.length ? `AND k.store IN (${p.stores.map(() => "?").join(", ")})` : "";
			const rows = await all<{ store: number; sku: string; descr: string; vendor: string; onHand: number; min: number; max: number; onOrder: number }>(
				`SELECT k.store, k.sku, i.descr, i.vendor, k.on_hand AS onHand, k.min_qty AS min, k.max_qty AS max,
				COALESCE((SELECT SUM(pl.qty - MIN(pl.received, pl.qty)) FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po
					WHERE po.store = k.store AND pl.sku = k.sku AND po.status IN ('O', 'P')), 0) AS onOrder
				FROM stock k JOIN items i ON i.sku = k.sku WHERE k.min_qty IS NOT NULL AND k.on_hand <= k.min_qty ${st}
				ORDER BY k.store, i.vendor, k.sku`, p.stores);
			out.head = [`${l("ST", 4)}${l("ITEM", 15)}${l("DESCRIPTION", 24)}${l("VENDOR", 9)}${r("ON HAND", 8)}${r("MIN", 6)}${r("MAX", 6)}${r("ON ORD", 7)}`, rule];
			for (const x of rows) {
				out.body.push(`${l(x.store, 4)}${l(x.sku, 15)}${l(x.descr, 24)}${l(x.vendor, 9)}${r(qty(x.onHand), 8)}${r(qty(x.min), 6)}${r(qty(x.max), 6)}${r(x.onOrder ? qty(x.onOrder) : "", 7)}`);
			}
			if (!rows.length) out.body.push("NOTHING IS AT OR BELOW ITS MINIMUM");
			out.body.push("", "3.3 SUGGESTED MAKES THE PURCHASE ORDERS.");
			break;
		}
	}
	return out;
}

// pages lays a report out for the printer: a heading on every page.
export function pages(rep: Report, printed: string, perPage: number): string[][] {
	const top = (n: number, of: number) => [
		`${rep.title}${`PAGE ${n} OF ${of}`.padStart(WIDTH - rep.title.length)}`,
		`${rep.sub}${printed.padStart(WIDTH - rep.sub.length)}`,
		"",
		...rep.head,
	];
	const room = Math.max(perPage - top(1, 1).length, 1);
	const count = Math.max(Math.ceil(rep.body.length / room), 1);
	return Array.from({ length: count }, (_, i) => [...top(i + 1, count), ...rep.body.slice(i * room, (i + 1) * room)]);
}
