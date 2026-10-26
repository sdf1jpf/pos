import type { AccessEnv } from "@greenscreen-dev/worker";
import type { Sessions } from "@greenscreen-dev/worker/sessions";
import type { Posting } from "./posting";

export interface Env extends AccessEnv {
	DB: D1Database;
	SESSIONS?: DurableObjectNamespace<Sessions<Env>>; // signed-on sessions and record locks
	POSTING?: Queue<Posting>; // sales to post to the stock ledger
	STATE_KEY?: string; // signs the commarea
	ADMIN_USERS?: string; // userids that are always administrators, comma separated
}
