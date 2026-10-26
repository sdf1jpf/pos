// A terminal for the tests: it signs on as a user, presses keys and keeps
// the commarea between screens, as the Go and browser terminals do.

import { env } from "cloudflare:workers";
import { expect } from "vitest";
import app from "../src/index";

export interface Field { row: number; col: number; text?: string; name?: string; value?: string; modified?: boolean }
export interface Reply { state?: string; screen?: { map: string; fields: Field[] }; logoff?: { message: string } }

export function terminal(user: string) {
	let state = "";
	let last: Reply = {};
	const e = { ...env, DEV_USER: user };
	async function key(aid: string, fields: Record<string, string> = {}, cursor = ""): Promise<Reply> {
		// Like a real terminal, send every input field on the screen, with
		// what was typed over the ones named.
		const all: Record<string, string> = {};
		for (const f of last.screen?.fields ?? []) if (f.name) all[f.name] = f.value ?? "";
		const modified = [
			...Object.keys(fields),
			...(last.screen?.fields ?? []).filter((f) => f.modified && f.name && !(f.name in fields)).map((f) => f.name!),
		];
		const res = await app.request("/v1/screen", {
			method: "POST",
			body: JSON.stringify({ v: 1, aid, state, fields: { ...all, ...fields }, modified, cursor: { row: 1, col: 1, field: cursor }, rows: 24, cols: 80 }),
		}, e);
		expect(res.status).toBe(200);
		last = (await res.json()) as Reply;
		state = last.state ?? "";
		return last;
	}
	return { key, state: () => state, setState: (s: string) => (state = s) };
}

// text is everything the screen shows, field by field.
export const text = (r: Reply) => (r.screen?.fields ?? []).map((f) => f.text ?? f.value ?? "").join("|");

export const value = (r: Reply, name: string) => r.screen?.fields.find((f) => f.name === name)?.value ?? "";

export const map = (r: Reply) => r.screen?.map;
