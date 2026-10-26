// The end-of-day close, as a Workflow: each step is kept once it is done,
// so a step that fails is retried without redoing the ones before it.
// The screen starts it (POS510) and shows the day as closing until the
// last step marks it closed.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { finishClose, openDrawers, postDay, zReport } from "./data/endofday";
import type { Env } from "./env";

export interface CloseParams {
	store: number;
	day: string;
	next: string; // the business day after it
	userid: string;
}

export class CloseDay extends WorkflowEntrypoint<Env, CloseParams> {
	async run(event: Readonly<WorkflowEvent<CloseParams>>, step: WorkflowStep) {
		const { store, day, next, userid } = event.payload;
		await step.do("check every drawer is closed", async () => {
			const open = await openDrawers(this.env.DB, store);
			if (open.length) throw new Error(`register ${open.map((d) => d.reg).join(", ")} still open`);
		});
		await step.do("post the day's sales to the stock ledger", () => postDay(this.env.DB, store, day));
		const z = await step.do("make the Z report", () => zReport(this.env.DB, store, day));
		await step.do("close the day", () => finishClose(this.env.DB, userid, z, next));
		return { store, day, total: z.total };
	}
}
