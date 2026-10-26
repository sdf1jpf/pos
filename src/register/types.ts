// The register panels' states. A lane (the register and who is signed on
// to it) travels in every one of them, in the signed commarea.

import type { PanelState } from "@greenscreen-dev/worker";
import type { Closed, Counts, Lane, Line, Tender } from "../data/register";

export interface LaneSelectState extends PanelState { p: "lane"; back: PanelState; errField?: string }
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
	voiding?: boolean; // PF12 pressed once: again voids the sale
	errField?: string;
}
export interface TenderState extends PanelState { p: "tender"; lane: Lane; back: SaleState; errField?: string }
export interface ReceiptState extends PanelState { p: "receipt"; lane: Lane; back: PanelState; sale: number; change?: number; top?: number }
export interface ReceiptsState extends PanelState {
	p: "receipts"; lane: Lane; back: PanelState; top?: number; total?: number; keys?: string[]; errSel?: string;
}
export interface FunctionsState extends PanelState { p: "functions"; lane: Lane; back: SaleState; errField?: string }
export interface PaidState extends PanelState { p: "paid"; lane: Lane; back: SaleState; kind: "PAIDIN" | "PAIDOUT"; token: string; errField?: string }
export interface CloseDrawerState extends PanelState { p: "closedrawer"; lane: Lane; back: SaleState; counts: Counts; closed?: Closed; errField?: string }
// A supervisor's or manager's approval of what the operator may not do
// alone, then the action approved.
export interface ApproveState extends PanelState { p: "approve"; lane: Lane; back: PanelState; action: "postvoid"; sale: number; errField?: string }
