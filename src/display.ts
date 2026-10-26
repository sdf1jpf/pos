// The customer display: a screen facing the customer that shows the sale
// as it is rung, its total, the card terminal's prompt, and the change.
// It is a web page (src/displaypage.ts), paired to one register with a
// code keyed there (POS238). Each register has a Display Durable Object
// that keeps what its display should show and pushes it, over a
// WebSocket, to the displays paired to it. The register panels tell it
// on every screen they show (onDisplay).

import { DurableObject } from "cloudflare:workers";
import type { AppEnv, Program } from "@greenscreen-dev/worker";
import type { Hono } from "hono";
import { display, hasDisplay, newDisplay } from "./data/displays";
import { getSale, registerInfo } from "./data/register";
import { PAGE } from "./displaypage";
import type { Env } from "./env";
import { dollars } from "./money";
import { receiptNo } from "./register/receipt";
import { priceSale, rows, tenderText } from "./register/sale";
import type { CardState, ReceiptState, SaleState } from "./register/types";
import type { PosCtx } from "./screens/types";

// What a display shows. Amounts are dollars and cents, as text.
export type View =
	| { v: "closed"; store?: string }
	| { v: "idle"; store: string; cashier: string }
	| {
			v: "sale"; store: string; cashier: string; customer?: string;
			lines: { desc: string; qty?: string; price?: string; amount: string; void?: boolean; off?: boolean }[];
			items: number; subtotal: string; savings?: string; tax: string; total: string;
			tenders: { what: string; amount: string }[]; paid?: string; due: string; refund: boolean;
			card?: { amount: string; refund: boolean };
	  }
	| { v: "done"; store: string; receipt: string; total: string; savings?: string; tenders: { what: string; amount: string }[]; change: string; refund: boolean };

// The most lines a display is sent: the last of them.
const MAX_LINES = 60;

// The Durable Object that keeps one register's view and its displays'
// WebSockets (hibernating, so an idle display costs nothing).
export class Display extends DurableObject<Env> {
	private last?: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Displays ping to keep the connection up; answered without waking.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// show sets what the register's displays show, sending it if it changed.
	async show(view: View): Promise<void> {
		const json = JSON.stringify(view);
		this.last ??= await this.ctx.storage.get<string>("view");
		if (json === this.last) return;
		this.last = json;
		await this.ctx.storage.put("view", json);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(json);
			} catch {
				// Gone: the runtime closes it.
			}
		}
	}

	// drop closes the WebSockets of displays no longer paired here.
	async drop(hashes: string[]): Promise<void> {
		for (const h of hashes) for (const ws of this.ctx.getWebSockets(h)) ws.close(4001, "unpaired");
	}

	// fetch takes a display's WebSocket, tagged with its token's hash, and
	// sends it what to show now.
	async fetch(req: Request): Promise<Response> {
		const hash = req.headers.get("X-Display") ?? "";
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server, [hash]);
		this.last ??= await this.ctx.storage.get<string>("view");
		server.send(this.last ?? JSON.stringify({ v: "closed" } satisfies View));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		try {
			ws.close(code === 1005 ? 1000 : code);
		} catch {
			// Already closed.
		}
	}
}

export const displayFor = (env: Env, store: number, reg: number) => env.DISPLAYS?.get(env.DISPLAYS.idFromName(`${store}/${reg}`));

// The register a panel's state is at, if any.
type AtLane = { lane?: { store: number; reg: number }; store?: number; reg?: number; back?: unknown; p: string };

function where(s: AtLane): { store: number; reg: number } | undefined {
	if (s.lane) return s.lane;
	if (typeof s.store === "number" && typeof s.reg === "number") return { store: s.store, reg: s.reg };
	return undefined;
}

// The sale a panel is over: itself, or the first sale back from it.
function saleUnder(s: AtLane): SaleState | undefined {
	for (let x: AtLane | undefined = s; x; x = x.back as AtLane | undefined) if (x.p === "sale") return x as unknown as SaleState;
	return undefined;
}

// Names as a customer sees them: Pat Jones, not PAT JONES.
const titled = (name: string) => name.trim().toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());

// The cashier as a customer sees them: their first name.
const firstName = (name: string) => titled(name.trim().split(/\s+/)[0] ?? "");

// viewOf is what a register's display shows under the panel state s.
export async function viewOf(ctx: PosCtx, s: AtLane, at: { store: number; reg: number }): Promise<View> {
	const db = ctx.env.DB;
	const store = titled((await registerInfo(db, at.store, at.reg))?.storeName ?? "");
	// Just paid: the receipt, with the change.
	if (s.p === "receipt" && (s as unknown as ReceiptState).change !== undefined) {
		const r = s as unknown as ReceiptState;
		const sale = await getSale(db, r.sale);
		if (sale) {
			return {
				v: "done", store, receipt: receiptNo(sale), total: dollars(sale.total), ...(sale.discount > 0 ? { savings: dollars(sale.discount) } : {}),
				tenders: sale.tenders.map((t) => ({ what: tenderText(t), amount: dollars(Math.abs(t.tendered)) })),
				change: dollars(sale.change), refund: sale.total < 0,
			};
		}
	}
	const sale = saleUnder(s);
	if (!sale) return { v: "closed", store };
	const cashier = firstName(sale.lane.name);
	if (sale.lines.length === 0 && sale.tenders.length === 0) return { v: "idle", store, cashier };
	const p = await priceSale(ctx, sale);
	const paid = sale.tenders.reduce((t, x) => t + x.amount, 0);
	const due = p.total - paid;
	const card = s.p === "card" ? (s as unknown as CardState) : undefined;
	return {
		v: "sale", store, cashier, ...(sale.customer ? { customer: titled(sale.customer.name) } : {}),
		lines: rows(sale, p).slice(-MAX_LINES).map((r) => ({
			desc: r.desc.trim(), amount: r.amount, ...(r.qty && r.qty !== "1" ? { qty: r.qty, price: r.price } : {}),
			...(r.void ? { void: true } : {}), ...(r.off ? { off: true } : {}),
		})),
		items: p.items, subtotal: dollars(p.subtotal), ...(p.discount ? { savings: dollars(p.discount) } : {}), tax: dollars(p.tax), total: dollars(p.total),
		tenders: sale.tenders.map((t) => ({ what: tenderText(t), amount: dollars(Math.abs(t.amount)) })),
		...(paid ? { paid: dollars(Math.abs(paid)) } : {}), due: dollars(Math.abs(due)), refund: due < 0,
		...(card ? { card: { amount: dollars(card.amount), refund: card.refund } } : {}),
	};
}

// show tells a register's displays what is on its screen now. A display
// that can't be told never stops the register.
async function show(ctx: PosCtx, s: AtLane): Promise<void> {
	const at = where(s);
	if (!at || !ctx.env.DISPLAYS) return;
	try {
		if (!(await hasDisplay(ctx.env.DB, at.store, at.reg))) return;
		await displayFor(ctx.env, at.store, at.reg)!.show(await viewOf(ctx, s, at));
	} catch (e) {
		console.error(`customer display ${at.store}/${at.reg}:`, e);
	}
}

// onDisplay makes the register panels show on their register's display:
// each time one renders, its display is told, alongside.
export function onDisplay<T extends Record<string, Program<never, Env>>>(programs: T): T {
	return Object.fromEntries(
		Object.entries(programs).map(([name, p]) => [name, {
			...p,
			async render(ctx: PosCtx, s: never) {
				const [scr] = await Promise.all([p.render(ctx, s), show(ctx, s as AtLane)]);
				return scr;
			},
		}]),
	) as T;
}

// The display's routes. Access may be in front (see README) but the app
// doesn't sign them on: a display proves itself with its token.
//   GET  /display               the page
//   POST /v1/display            a new display: its token and pairing code
//   GET  /v1/display            this display: its code, or its register
//   GET  /v1/display/ws?t=      its WebSocket, once paired
export function displayRoutes(app: Hono<AppEnv<Env>>): void {
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
	const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "")?.[1] ?? "";
	app.get("/display", () => new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }));
	app.post("/v1/display", async (c) => json(await newDisplay(c.env.DB), 201));
	app.get("/v1/display", async (c) => {
		const d = await display(c.env.DB, bearer(c.req.raw));
		if (!d) return json({ error: "unknown display" }, 401);
		if (d.store === null || d.reg === null) return json({ paired: false, code: d.code });
		const r = await registerInfo(c.env.DB, d.store, d.reg);
		return json({ paired: true, store: d.store, reg: d.reg, name: r?.name ?? "", storeName: r?.storeName ?? "" });
	});
	app.get("/v1/display/ws", async (c) => {
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "a WebSocket: send Upgrade: websocket" }, 426);
		const d = await display(c.env.DB, c.req.query("t") ?? "");
		if (!d) return json({ error: "unknown display" }, 401);
		if (d.store === null || d.reg === null) return json({ error: "not paired" }, 409);
		const stub = displayFor(c.env, d.store, d.reg);
		if (!stub) return json({ error: "no customer displays here" }, 503);
		const req = new Request(c.req.raw);
		req.headers.set("X-Display", d.hash);
		return stub.fetch(req);
	});
}
