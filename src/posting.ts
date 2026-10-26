// Posting sales to the stock ledger, off the register's path. The register
// writes the sale and queues its number; the queue's consumer posts it.
// postSale is safe to run twice, so a message delivered again, or the
// sweep finding a sale whose message was lost, changes nothing.

import { postSale, unposted } from "./data/stock";
import type { Env } from "./env";

export interface Posting {
	sale: number;
}

// queuePosting asks for a sale to be posted. If the queue can't take it,
// the sale stays unposted and the next sweep posts it: the sale itself is
// already written, and the cashier is never kept waiting on the ledger.
export async function queuePosting(env: Env, sale: number): Promise<void> {
	try {
		await env.POSTING?.send({ sale });
	} catch (e) {
		console.warn(`posting sale ${sale} left to the sweep:`, e);
	}
}

export async function consume(batch: MessageBatch<Posting>, env: Env): Promise<void> {
	for (const m of batch.messages) {
		try {
			await postSale(env.DB, m.body.sale);
			m.ack();
		} catch (e) {
			console.error(`posting sale ${m.body.sale} failed:`, e);
			m.retry();
		}
	}
}

// sweep posts whatever the queue missed.
export async function sweep(env: Env): Promise<number> {
	const ids = await unposted(env.DB, 500);
	for (const id of ids) await postSale(env.DB, id);
	return ids.length;
}
