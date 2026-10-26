// The register panels' states. A lane (the register and who is signed on
// to it) travels in every one of them, in the signed commarea.

import type { PanelState } from "@greenscreen-dev/worker";
import type { SaleDisc } from "../data/pricing";
import type { Closed, Counts, Lane, Line, Tender } from "../data/register";

export interface LaneSelectState extends PanelState { p: "lane"; back: PanelState; errField?: string }
// A clerk signed on through Access, choosing their register.
export interface ClerkLaneState extends PanelState { p: "clerklane"; errField?: string }
// No lane yet: the register being signed on to. back is the back office
// menu when the register was opened from there.
export interface SignOnState extends PanelState { p: "signon"; store: number; reg: number; via: Lane["via"]; errField?: string }
export interface OpenDrawerState extends PanelState { p: "opendrawer"; lane: Lane; counts: Counts; errField?: string }
export interface SaleState extends PanelState {
	p: "sale";
	lane: Lane;
	token: string; // writes the sale once
	lines: Line[];
	tenders: Tender[];
	coupons: string[]; // codes, in the order taken
	saleDisc?: SaleDisc;
	customer?: { id: number; name: string; phone: string; exempt: boolean };
	voiding?: boolean; // PF12 pressed once: again voids the sale
	errField?: string;
}
export interface TenderState extends PanelState { p: "tender"; lane: Lane; back: SaleState; errField?: string }
// A card tender waiting on the card terminal. amount is in cents, positive
// for a refund too.
export interface CardState extends PanelState { p: "card"; lane: Lane; back: TenderState; amount: number; refund: boolean }
export interface ReceiptState extends PanelState { p: "receipt"; lane: Lane; back: PanelState; sale: number; change?: number; top?: number }
export interface ReceiptsState extends PanelState {
	p: "receipts"; lane: Lane; back: PanelState; top?: number; total?: number; keys?: string[]; errSel?: string;
}
export interface FunctionsState extends PanelState { p: "functions"; lane: Lane; back: SaleState; errField?: string }
export interface PaidState extends PanelState { p: "paid"; lane: Lane; back: SaleState; kind: "PAIDIN" | "PAIDOUT"; token: string; errField?: string }
export interface CloseDrawerState extends PanelState { p: "closedrawer"; lane: Lane; back: SaleState; counts: Counts; closed?: Closed; errField?: string }
export interface DiscountState extends PanelState { p: "discount"; lane: Lane; back: SaleState; errField?: string }
// A return: a receipt recalled (sale), or an item without one.
export interface ReturnState extends PanelState { p: "return"; lane: Lane; back: SaleState; sale?: number; noReceipt?: boolean; errField?: string; errSel?: string }
export interface CustomerState extends PanelState { p: "customer"; lane: Lane; back: SaleState; phone?: string; adding?: boolean; errField?: string }
export interface GiftState extends PanelState { p: "gift"; lane: Lane; back: SaleState; errField?: string }
export interface ResumeState extends PanelState { p: "resume"; lane: Lane; back: SaleState; keys?: string[]; errSel?: string }

// A discount or override waiting for approval. line is 1-based; none is
// the sale discount.
export interface Pending {
	line?: number;
	pct?: number; // hundredths of a percent
	amount?: number;
	price?: number; // a price override
	reason?: string;
	add?: Line; // a line to add: a return without a receipt
	what: string; // what is being approved, for the screen and the audit
}

// A supervisor's or manager's approval of what the operator may not do
// alone, then the action approved: a post-void of a paid sale, or a
// discount or price override on the sale being rung (in back.back).
export type ApproveState = PanelState & { p: "approve"; lane: Lane; back: PanelState; errField?: string } & (
	| { action: "postvoid"; sale: number }
	| { action: "adjust"; back: DiscountState | ReturnState; pending: Pending }
);
