import type { AccessEnv } from "@greenscreen-dev/worker";

export interface Env extends AccessEnv {
	DB: D1Database;
	STATE_KEY?: string; // signs the commarea
	ADMIN_USERS?: string; // userids that are always administrators, comma separated
}
