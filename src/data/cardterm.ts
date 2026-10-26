// The card terminal beside each register, simulated. A real one would take
// the customer's card, talk to the processor and answer with the card's
// last 4 and an approval code, or a decline. This one makes those up: the
// clerk never keys them.

export type Entry = "CHIP" | "TAP" | "SWIPE";

export interface CardResult {
	approved: boolean;
	brand: string;
	last4: string;
	entry: Entry;
	auth?: string; // the approval code, when approved
	reason?: string; // why not, when declined
}

const BRANDS = ["VISA", "MASTERCARD", "AMEX", "DISCOVER"];
const ENTRIES: Entry[] = ["CHIP", "TAP", "SWIPE"];
const DECLINES = ["INSUFFICIENT FUNDS", "DO NOT HONOR", "CARD EXPIRED", "PICK UP CARD"];
const AUTH = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";

const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;

// runCard charges amount (cents) to the customer's card, or refunds it to
// one. decline has the customer's card declined, as the clerk asks for when
// trying out what a decline looks like. Refunds aren't declined.
export function runCard(amount: number, refund: boolean, decline = false): CardResult {
	if (!Number.isInteger(amount) || amount <= 0) throw new Error(`card terminal: bad amount ${amount}`);
	const card = { brand: pick(BRANDS), last4: String(Math.floor(Math.random() * 10000)).padStart(4, "0"), entry: pick(ENTRIES) };
	if (decline && !refund) return { ...card, approved: false, reason: pick(DECLINES) };
	return { ...card, approved: true, auth: Array.from({ length: 6 }, () => pick([...AUTH])).join("") };
}
