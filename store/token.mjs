#!/usr/bin/env node
// Prints a register's line for REGISTER_TOKENS: its service token's client
// ID and the SHA-256 of its secret. npm run store:token -- <client id> <secret>

import { createHash } from "node:crypto";

const [id, secret] = process.argv.slice(2);
if (!id || !secret) {
	console.error("usage: npm run store:token -- <client id> <secret>");
	process.exit(1);
}
const t = id.trim().toLowerCase();
console.log(JSON.stringify({ [t.endsWith(".access") ? t : `${t}.access`]: createHash("sha256").update(secret).digest("hex") }));
