// The Worker's entry: the app, the queue consumer and cron sweep that post
// sales to the stock ledger, the end-of-day Workflow, and the Durable
// Object that keeps sessions and record locks. On a store server the cron
// syncs with the cloud.
import app from "./index";
import type { Env } from "./env";
import { consume, sweep, type Posting } from "./posting";
import { syncStore } from "./sync";

export { Sessions } from "@greenscreen-dev/worker/sessions";
export { CloseDay } from "./closeday";

export default {
	fetch: app.fetch,
	queue: (batch, env) => consume(batch, env),
	// A store server syncs with the cloud instead: the cloud posts its sales.
	scheduled: async (_event, env, ctx) => {
		ctx.waitUntil(env.STORE ? syncStore(env) : sweep(env));
	},
} satisfies ExportedHandler<Env, Posting>;
