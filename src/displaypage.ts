// The customer display's page, served at GET /display (see src/display.ts).
// It asks for a pairing code, shows it until a clerk keys it at a register,
// then shows what the register sends over its WebSocket. Its token is kept
// in the browser, so it stays paired across restarts.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Customer display</title>
<style>
:root { --bg: #08130c; --panel: #0f2216; --line: #1f3a28; --fg: #e8f5ec; --dim: #8fb09a; --accent: #3ddc84; --warn: #ffd166; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; background: var(--bg); color: var(--fg); font: 400 2.4vh/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; cursor: none; }
.num { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
#app { height: 100%; }
.center { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 2vh; padding: 4vh; }
.big { font-size: 9vh; font-weight: 700; letter-spacing: -0.02em; }
.huge { font-size: 14vh; font-weight: 700; color: var(--accent); }
.dim { color: var(--dim); }
.code { font-size: 16vh; letter-spacing: 0.15em; color: var(--accent); }
.sale { height: 100%; display: grid; grid-template-columns: 1.4fr 1fr; }
.lines { padding: 3vh 3vw; overflow: hidden; display: flex; flex-direction: column; }
.lines h2 { font-size: 2.4vh; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 1.5vh; }
.list { flex: 1; overflow: hidden; }
.row { display: flex; gap: 2vw; padding: 1vh 0; border-bottom: 1px solid var(--line); font-size: 3vh; }
.row .d { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .q { color: var(--dim); font-size: 2.2vh; display: block; }
.row.off { color: var(--warn); font-size: 2.4vh; padding: 0.5vh 0 0.5vh 2vw; }
.row.void { color: var(--dim); text-decoration: line-through; }
.row.new { animation: flash 1.2s ease-out; }
@keyframes flash { from { background: #1d4d2e; } to { background: transparent; } }
.totals { background: var(--panel); padding: 4vh 3vw; display: flex; flex-direction: column; gap: 1.6vh; }
.t { display: flex; justify-content: space-between; font-size: 3.2vh; }
.t.save { color: var(--warn); }
.t.total { font-size: 6vh; font-weight: 700; border-top: 2px solid var(--line); padding-top: 2vh; margin-top: 1vh; }
.t.due { font-size: 5vh; font-weight: 700; color: var(--accent); }
.spacer { flex: 1; }
.store { color: var(--dim); font-size: 2.4vh; }
.card { position: fixed; inset: 0; background: rgba(4, 10, 6, 0.92); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3vh; text-align: center; }
.card .huge { font-size: 16vh; }
.foot { position: fixed; bottom: 2vh; left: 0; right: 0; text-align: center; color: var(--dim); font-size: 2vh; }
@media (orientation: portrait) { .sale { grid-template-columns: 1fr; grid-template-rows: 1fr auto; } }
</style>
</head>
<body>
<div id="app"><div class="center"><div class="dim">Starting...</div></div></div>
<script>
"use strict";
const app = document.getElementById("app");
const KEY = "posDisplayToken";
let token = null;
try { token = localStorage.getItem(KEY); } catch (e) {}
const save = (t) => { token = t; try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {} };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (s) => "$" + s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function screen(html) { app.innerHTML = html; }

function waiting(msg) {
	screen('<div class="center"><div class="big">Welcome</div><div class="dim">' + esc(msg) + "</div></div>");
}

function showCode(code) {
	screen('<div class="center"><div class="dim">Customer display</div><div class="code num">' + esc(code) +
		'</div><div>To pair this display, at the register press <b>PF4</b> (functions), take option <b>12</b> and key this code.</div></div>');
}

let shownLines = 0;
let doneUntil = 0;
let pending = null;

function render(v) {
	// The thank-you stays up a while, unless the next sale starts.
	if (v.v === "idle" && Date.now() < doneUntil) {
		clearTimeout(pending);
		pending = setTimeout(() => render(v), doneUntil - Date.now());
		return;
	}
	clearTimeout(pending);
	if (v.v !== "sale") shownLines = 0;
	if (v.v === "closed") {
		screen('<div class="center"><div class="big">This register is closed</div><div class="dim">Please use another register' +
			(v.store ? "<br>" + esc(v.store) : "") + "</div></div>");
	} else if (v.v === "idle") {
		screen('<div class="center"><div class="big">Welcome' + (v.store ? " to " + esc(v.store) : "") + "</div>" +
			(v.cashier ? '<div class="dim">Your cashier today is ' + esc(v.cashier) + "</div>" : "") + "</div>");
	} else if (v.v === "done") {
		doneUntil = Date.now() + 10000;
		const change = v.change !== "0.00";
		screen('<div class="center"><div class="big">Thank you!</div>' +
			(change ? '<div class="dim">Your change</div><div class="huge num">' + money(esc(v.change)) + "</div>"
				: '<div class="dim">' + (v.refund ? "Refunded" : "Total") + '</div><div class="huge num">' + money(esc(v.total.replace("-", ""))) + "</div>") +
			(v.savings ? '<div style="color:var(--warn)">You saved ' + money(esc(v.savings)) + " today</div>" : "") +
			'<div class="dim">' + v.tenders.map((t) => esc(t.what) + " " + money(esc(t.amount))).join(" &middot; ") + "</div>" +
			'<div class="dim">Receipt ' + esc(v.receipt) + "</div></div>");
	} else if (v.v === "sale") {
		const rows = v.lines.map((l, i) => {
			const cls = "row" + (l.off ? " off" : "") + (l.void ? " void" : "") + (i >= shownLines && !l.off ? " new" : "");
			const q = l.qty ? '<span class="q num">' + esc(l.qty) + " @ " + money(esc(l.price)) + "</span>" : "";
			return '<div class="' + cls + '"><div class="d">' + esc(l.desc) + q + '</div><div class="num">' + esc(l.amount) + "</div></div>";
		}).join("");
		shownLines = v.lines.length;
		const t = (label, amount, cls) => '<div class="t ' + (cls || "") + '"><span>' + label + '</span><span class="num">' + amount + "</span></div>";
		screen('<div class="sale"><div class="lines"><h2>' + (v.customer ? "Welcome back, " + esc(v.customer) : "Your items") +
			'</h2><div class="list">' + rows + '</div></div><div class="totals">' +
			t("Items", esc(v.items)) + t("Subtotal", money(esc(v.subtotal))) +
			(v.savings ? t("You save", "-" + money(esc(v.savings)), "save") : "") +
			t("Tax", money(esc(v.tax))) + t("Total", money(esc(v.total)), "total") +
			v.tenders.map((x) => t(esc(x.what), money(esc(x.amount)))).join("") +
			(v.paid ? t(v.refund ? "Refund due" : "Balance due", money(esc(v.due)), "due") : "") +
			'<div class="spacer"></div><div class="store">' + esc(v.store) + (v.cashier ? " &middot; " + esc(v.cashier) : "") + "</div></div></div>" +
			(v.card ? '<div class="card"><div class="dim">' + (v.card.refund ? "Refund to your card" : "Please pay on the card terminal") +
				'</div><div class="huge num">' + money(esc(v.card.amount)) + '</div><div class="big">Insert, tap or swipe</div></div>' : ""));
		// The newest line is at the bottom: keep it in sight.
		const list = app.querySelector(".list");
		list.scrollTop = list.scrollHeight;
	}
}

async function api(method) {
	const res = await fetch("/v1/display", { method, headers: token ? { Authorization: "Bearer " + token } : {}, credentials: "same-origin", cache: "no-store" });
	if (res.status === 401) return null;
	if (!res.ok) throw new Error("HTTP " + res.status);
	return res.json();
}

// connect stays on the register's WebSocket until it closes.
function connect() {
	return new Promise((resolve) => {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(proto + "//" + location.host + "/v1/display/ws?t=" + encodeURIComponent(token));
		const ping = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 25000);
		ws.onmessage = (e) => { if (e.data !== "pong") { try { render(JSON.parse(e.data)); } catch (err) {} } };
		ws.onclose = () => { clearInterval(ping); resolve(); };
	});
}

async function run() {
	let backoff = 1000;
	for (;;) {
		try {
			if (!token) save((await api("POST")).token);
			const d = await api("GET");
			if (!d) { save(null); continue; }
			backoff = 1000;
			if (!d.paired) { showCode(d.code); await sleep(3000); continue; }
			await connect();
			await sleep(1000);
		} catch (e) {
			waiting("Connecting to the register...");
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 30000);
		}
	}
}
run();
</script>
</body>
</html>
`;
