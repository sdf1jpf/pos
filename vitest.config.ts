import { readFile } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				// A store server's database, for the sync tests.
				d1Databases: ["STORE_DB"],
				// No Access in the tests: each request signs on as DEV_USER,
				// which the tests set per terminal.
				bindings: {
					ACCESS_TEAM_DOMAIN: "",
					ACCESS_AUD: "",
					ADMIN_USERS: "ADMIN",
					STATE_KEY: "test-key",
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
					TEST_SEED: await readFile("./seed.sql", "utf8"),
				},
			},
		}),
	],
	test: { setupFiles: ["./test/setup.ts"] },
}));
