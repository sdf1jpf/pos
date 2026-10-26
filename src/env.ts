import type { AccessEnv } from "@greenscreen-dev/worker";
import type { Sessions } from "@greenscreen-dev/worker/sessions";
import type { CloseParams } from "./closeday";
import type { Posting } from "./posting";

export interface Env extends AccessEnv {
	DB: D1Database;
	SESSIONS?: DurableObjectNamespace<Sessions<Env>>; // signed-on sessions and record locks
	POSTING?: Queue<Posting>; // sales to post to the stock ledger
	CLOSE_DAY?: Workflow<CloseParams>; // end-of-day close
	STATE_KEY?: string; // signs the commarea
	ADMIN_USERS?: string; // userids that are always administrators, comma separated
	// A store server (store/README.md) has these; the cloud has none of them.
	STORE?: string; // the store it runs
	CLOUD_URL?: string; // the cloud app, e.g. https://greenscreen-pos.example.workers.dev
	CLOUD_TOKEN_ID?: string; // the service token it signs on to the cloud with
	CLOUD_TOKEN_SECRET?: string;
	REGISTER_TOKENS?: string; // JSON: each register's service token client ID to the SHA-256 of its secret
}
