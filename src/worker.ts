// The Worker's entry: the app, the queue consumer and cron sweep that post
// sales to the stock ledger, and the Durable Object that keeps sessions and
// record locks.
import app from "./index";
import type { Env } from "./env";
import { consume, sweep, type Posting } from "./posting";

export { Sessions } from "@greenscreen-dev/worker/sessions";

export default {
	fetch: app.fetch,
	queue: (batch, env) => consume(batch, env),
	scheduled: async (_event, env, ctx) => {
		ctx.waitUntil(sweep(env));
	},
} satisfies ExportedHandler<Env, Posting>;
