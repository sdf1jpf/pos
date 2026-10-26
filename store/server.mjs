#!/usr/bin/env node
// Runs a store server: the POS Worker on this machine, on its own
// database, for the store's registers to use when the internet is down
// (and when it isn't). It applies the migrations, serves on PORT (8080),
// and syncs with the cloud every SYNC_SECONDS (10). See store/README.md.
//
// It runs the Worker under wrangler's local runtime, workerd: the same
// runtime as Cloudflare's, with D1 as SQLite files in STORE_DATA
// (store/data). Settings are in store/.dev.vars, or the file in STORE_VARS.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wrangler = join(here, "..", "node_modules", ".bin", "wrangler");
const config = join(here, "wrangler.jsonc");
const data = resolve(process.env.STORE_DATA ?? join(here, "data"));
const vars = resolve(process.env.STORE_VARS ?? join(here, ".dev.vars"));
const port = process.env.PORT ?? "8080";
const ip = process.env.STORE_IP ?? "0.0.0.0";
const every = Number(process.env.SYNC_SECONDS ?? "10") * 1000;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };

if (!existsSync(vars)) {
	console.error(`No settings: copy store/.dev.vars.example to ${vars} and fill it in.`);
	process.exit(1);
}

execFileSync(wrangler, ["d1", "migrations", "apply", "greenscreen-pos-store", "--local", "--persist-to", data, "-c", config], { stdio: "inherit", env });

const dev = spawn(wrangler, [
	"dev", "-c", config, "--local", "--persist-to", data, "--env-file", vars,
	"--ip", ip, "--port", port, "--test-scheduled", "--show-interactive-dev-session=false", "--log-level", "warn",
], { stdio: "inherit", env });
dev.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => dev.kill(sig));

// The sync: the Worker's scheduled handler, run by asking for it. One at
// a time; a sync that fails is tried again next time round.
const local = `http://127.0.0.1:${port}`;
async function tick() {
	try {
		await fetch(`${local}/__scheduled`);
	} catch {
		// not up yet
	}
	setTimeout(tick, every);
}
setTimeout(tick, 3000);
