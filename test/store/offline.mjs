#!/usr/bin/env node
// The offline test: a cloud and a store server, each the real Worker under
// wrangler's local runtime on its own database. The store takes the master
// data, the cloud goes away, a register rings a sale on the store server,
// the cloud comes back, and the sale arrives. npm run test:store

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wrangler = join(root, "node_modules", ".bin", "wrangler");
const dir = mkdtempSync(join(tmpdir(), "pos-offline-"));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
const CLOUD_PORT = 8791;
const STORE_PORT = 8792;
const SERVER = "srv1.access";
const REG = "reg2.access";
const SPAN = 10_000_000_000;

const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function cloudSql(sql) {
	const out = execFileSync(wrangler, ["d1", "execute", "greenscreen-pos", "--local", "--persist-to", join(dir, "cloud"), "--json", "--command", sql],
		{ cwd: root, env, encoding: "utf8" });
	return JSON.parse(out)[0].results;
}

// The cloud, with Access off: every request signs on as the store server.
function startCloud() {
	const c = spawn(wrangler, ["dev", "-c", "wrangler.jsonc", "--local", "--persist-to", join(dir, "cloud"), "--env-file", join(dir, "cloud.vars"),
		"--port", String(CLOUD_PORT), "--ip", "127.0.0.1", "--show-interactive-dev-session=false", "--log-level", "warn"],
	{ cwd: root, env, stdio: "inherit" });
	children.push(c);
	return c;
}

async function until(what, f, seconds = 60) {
	for (let i = 0; i < seconds * 2; i++) {
		try {
			const v = await f();
			if (v) return v;
		} catch {
			// not yet
		}
		await sleep(500);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const up = (port) => until(`port ${port}`, async () => (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok);

// A register on the store server: its service token, and the screen protocol.
function register() {
	let state = "";
	let last = {};
	return async (aid, fields = {}) => {
		const all = Object.fromEntries((last.screen?.fields ?? []).filter((f) => f.name).map((f) => [f.name, f.value ?? ""]));
		const res = await fetch(`http://127.0.0.1:${STORE_PORT}/v1/screen`, {
			method: "POST",
			headers: { "CF-Access-Client-Id": REG, "CF-Access-Client-Secret": "pw", "Content-Type": "application/json" },
			body: JSON.stringify({ v: 1, aid, state, fields: { ...all, ...fields }, modified: Object.keys(fields), cursor: { row: 1, col: 1, field: "" }, rows: 24, cols: 80 }),
		});
		if (!res.ok) throw new Error(`screen: ${res.status} ${await res.text()}`);
		last = await res.json();
		state = last.state ?? "";
		return { map: last.screen?.map, text: (last.screen?.fields ?? []).map((f) => f.text ?? f.value ?? "").join("|"), logoff: last.logoff };
	};
}

function expect(ok, what) {
	if (!ok) throw new Error(`FAILED: ${what}`);
	console.log(`ok: ${what}`);
}

try {
	step("a cloud with the test data, and store 1's server token");
	writeFileSync(join(dir, "cloud.vars"), "ACCESS_TEAM_DOMAIN=\nACCESS_AUD=\nDEV_USER=srv1.access\nSTATE_KEY=cloud\n");
	execFileSync(wrangler, ["d1", "migrations", "apply", "greenscreen-pos", "--local", "--persist-to", join(dir, "cloud")], { cwd: root, env, stdio: "inherit" });
	execFileSync(wrangler, ["d1", "execute", "greenscreen-pos", "--local", "--persist-to", join(dir, "cloud"), "--file", "seed.sql"], { cwd: root, env, stdio: "inherit" });
	cloudSql(`UPDATE stores SET server_token = '${SERVER}' WHERE store = 1; UPDATE registers SET token_id = '${REG}' WHERE store = 1 AND reg = 2`);
	let cloud = startCloud();
	await up(CLOUD_PORT);

	step("a store server for store 1");
	const hash = createHash("sha256").update("pw").digest("hex");
	writeFileSync(join(dir, "store.vars"), [
		"STORE=1", `CLOUD_URL=http://127.0.0.1:${CLOUD_PORT}`, `CLOUD_TOKEN_ID=${SERVER}`, "CLOUD_TOKEN_SECRET=x",
		`REGISTER_TOKENS={"${REG}":"${hash}"}`, "STATE_KEY=store", "",
	].join("\n"));
	const store = spawn(process.execPath, [join(root, "store", "server.mjs")], {
		cwd: root, stdio: "inherit",
		env: { ...env, STORE_DATA: join(dir, "store"), STORE_VARS: join(dir, "store.vars"), PORT: String(STORE_PORT), STORE_IP: "127.0.0.1", SYNC_SECONDS: "2" },
	});
	children.push(store);
	await up(STORE_PORT);

	step("the store takes the master data: then its register signs on");
	const key = register();
	const r0 = await until("the register to be known", async () => {
		const r = await key("START");
		return r.map === "POS210" ? r : undefined;
	});
	expect(r0.text.includes("FRONT LANE 2"), "the register signs on at the store server");

	step("the cloud goes away");
	cloud.kill("SIGTERM");
	await until("the cloud to stop", async () => {
		try {
			await fetch(`http://127.0.0.1:${CLOUD_PORT}/v1/health`);
			return false;
		} catch {
			return true;
		}
	});

	step("a sale is rung with the cloud gone");
	let r = await key("ENTER", { operator: "3001", pin: "1234" });
	if (r.map === "POS211") r = await key("PF10", { "n:20": "5" });
	expect(r.map === "POS220", "the drawer opens");
	await key("ENTER", { item: "300100" });
	await key("PF5");
	r = await key("ENTER", { method: "C", amount: "20" });
	expect(r.text.includes("SALE L1 COMPLETE"), "the sale completes, numbered L1");
	await sleep(5000);
	expect(cloudSql(`SELECT COUNT(*) AS n FROM sales WHERE id > ${SPAN}`)[0].n === 0, "the cloud hasn't got it");

	step("the cloud comes back, and the sale arrives");
	cloud = startCloud();
	await up(CLOUD_PORT);
	const got = await until("the sale in the cloud", () => {
		const rows = cloudSql(`SELECT id, store, reg, total, posted FROM sales WHERE id > ${SPAN}`);
		return rows.length ? rows : undefined;
	});
	expect(got.length === 1 && got[0].id === SPAN + 1 && got[0].store === 1 && got[0].reg === 2, "sale L1 is in the cloud");
	expect(cloudSql(`SELECT COUNT(*) AS n FROM sale_tenders WHERE sale = ${SPAN + 1} AND kind = 'CASH'`)[0].n === 1, "with its tender");
	expect(cloudSql(`SELECT COUNT(*) AS n FROM drawers WHERE id = ${SPAN + 1} AND store = 1 AND reg = 2`)[0].n === 1, "and its drawer");
	console.log("\nPASS");
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	for (const c of children) c.kill("SIGTERM");
	await sleep(1000);
	rmSync(dir, { recursive: true, force: true });
}
