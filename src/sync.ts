// In-store mode. A store server runs this same Worker on a machine in the
// store (see store/README.md), with its own database, so the store's
// registers keep selling when its internet is down. Every few seconds it
// sends the cloud what its registers wrote and fetches what changed in
// the cloud: GET and POST /v1/sync, signed on through Access with the
// server's own service token (POS811's SERVER TOKEN).

import { HttpError, json, readJSON } from "@greenscreen-dev/worker";
import { applyDown, applyUp, changesAfter, pullFor, sent, setSite, storeForServer, syncFailed, syncState, SyncError, UP, type Change } from "./data/sync";
import type { Env } from "./env";

const PAGE = 200;

// The cloud's side.

async function serverStore(env: Env, user: string): Promise<number> {
	if (env.STORE) throw new HttpError(404, "not_found", "no such endpoint");
	const store = await storeForServer(env.DB, user);
	if (store === undefined) throw new HttpError(403, "unauthorized", `${user} is not a store server`);
	return store;
}

// GET /v1/sync?since=rev: the master data changed since rev.
export async function pull(env: Env, user: string, url: URL): Promise<Response> {
	const store = await serverStore(env, user);
	const since = Number(url.searchParams.get("since") ?? "0");
	if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, "bad_request", "since is a rev, 0 or more");
	const { changes, upTo } = await pullFor(env.DB, store, since, PAGE);
	return json(200, { store, changes, upTo });
}

// POST /v1/sync {changes, upTo}: what the store's registers wrote.
export async function push(env: Env, user: string, req: Request): Promise<Response> {
	const store = await serverStore(env, user);
	const body = await readJSON(req, ["changes", "upTo"]);
	const changes = body.changes as Change[];
	const upTo = Number(body.upTo);
	if (!Array.isArray(changes) || !Number.isSafeInteger(upTo)) throw new HttpError(400, "bad_request", "send changes and upTo");
	try {
		await applyUp(env.DB, store, changes, upTo);
	} catch (e) {
		if (e instanceof SyncError) throw new HttpError(400, "bad_request", e.message);
		throw e;
	}
	return json(200, { store, pushed: upTo });
}

// The store's side: run by the store server's clock (store/server.mjs).

export interface SyncResult {
	pushed: number;
	pulled: number;
	skipped: string[];
	error?: string;
}

// Cloud makes a request of the cloud and returns its JSON.
export type Cloud = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;

export async function syncStore(env: Env, cloud: Cloud = cloudFetch(env)): Promise<SyncResult> {
	const store = Number(env.STORE);
	const out: SyncResult = { pushed: 0, pulled: 0, skipped: [] };
	await setSite(env.DB, store);
	try {
		// Up first: what the registers wrote here is never held up by what
		// comes down.
		for (let i = 0; i < 20; i++) {
			const st = (await syncState(env.DB, store))!;
			const changes = await changesAfter(env.DB, UP, st.pushed, PAGE);
			if (!changes.length) break;
			const upTo = changes[changes.length - 1].rev;
			await cloud("POST", "/v1/sync", { changes: changes.filter((c) => UP[c.tbl]), upTo });
			await sent(env.DB, store, upTo);
			out.pushed += changes.length;
		}
		for (let i = 0; i < 20; i++) {
			const st = (await syncState(env.DB, store))!;
			const r = (await cloud("GET", `/v1/sync?since=${st.pulled}`)) as { changes: Change[]; upTo: number };
			if (r.upTo <= st.pulled) break;
			out.skipped.push(...(await applyDown(env.DB, store, r.changes, r.upTo)));
			out.pulled += r.changes.length;
		}
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
		await syncFailed(env.DB, store, out.error);
	}
	for (const s of out.skipped) console.warn(`sync: skipped ${s}`);
	if (out.error) console.warn(`sync: ${out.error}`);
	return out;
}

const cloudFetch = (env: Env): Cloud => async (method, path, body) => {
	if (!env.CLOUD_URL) throw new Error("CLOUD_URL is not set");
	const res = await fetch(new URL(path, env.CLOUD_URL), {
		method,
		headers: {
			"CF-Access-Client-Id": env.CLOUD_TOKEN_ID ?? "",
			"CF-Access-Client-Secret": env.CLOUD_TOKEN_SECRET ?? "",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		redirect: "manual",
	});
	if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
	return res.json();
};
