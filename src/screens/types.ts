// The panels' states. Each is plain JSON that travels in the signed
// commarea; "p" names the panel, "back" is where PF3 goes.

import type { Ctx, PanelState } from "@greenscreen-dev/worker";
import type { Env } from "../env";

export type PosCtx = Ctx<Env>;

// A list: the first row shown and the keys of the rows on screen, so that
// a selection code is matched to the row the operator saw.
interface ListState extends PanelState { back: PanelState; top?: number; total?: number; keys?: string[]; errSel?: string }

export interface ItemsState extends ListState { p: "items"; q?: string; dept?: number; errField?: string }
export interface ItemState extends PanelState { p: "item"; back: PanelState; sku?: string; version?: number; errField?: string } // no sku: adding
export interface DeptsState extends ListState { p: "depts"; errField?: string }
export interface PricesState extends ListState { p: "prices"; store?: number; q?: string; errField?: string }
export interface StoresState extends ListState { p: "stores" }
export interface StoreState extends PanelState { p: "store"; back: PanelState; store?: number; version?: number; errField?: string }
export interface RegistersState extends ListState { p: "registers"; store?: number; errField?: string }
export interface EmployeesState extends ListState { p: "employees" }
export interface EmployeeState extends PanelState { p: "employee"; back: PanelState; emp?: number; version?: number; errField?: string }
export interface PromotionsState extends ListState { p: "promotions" }
export interface PromotionState extends PanelState { p: "promotion"; back: PanelState; id?: number; version?: number; errField?: string }
export interface CouponsState extends ListState { p: "coupons" }
export interface CouponState extends PanelState { p: "coupon"; back: PanelState; code?: string; version?: number; errField?: string }
export interface StockState extends ListState { p: "stock"; store?: number; q?: string; dept?: number; errField?: string }
export interface LedgerState extends PanelState { p: "ledger"; back: PanelState; store: number; sku: string; top?: number; total?: number }
// token names the adjustment, so Enter pressed twice adjusts once.
export interface AdjustState extends PanelState { p: "adjust"; back: PanelState; store?: number; sku?: string; token: string; errField?: string }
export interface CountsState extends ListState { p: "counts"; store?: number; errField?: string }
export interface CountState extends ListState { p: "count"; id: number }
export interface TransfersState extends ListState { p: "transfers" }
export interface TransferState extends PanelState { p: "transfer"; back: PanelState; id?: number; errField?: string } // no id: starting one
export interface VendorsState extends ListState { p: "vendors" }
export interface VendorState extends PanelState { p: "vendor"; back: PanelState; code?: string; version?: number; errField?: string } // no code: adding
export interface PosState extends ListState { p: "pos"; all?: boolean }
// token names the next delivery received, so Enter pressed twice receives once.
export interface PoState extends PanelState { p: "po"; back: PanelState; id?: number; token: string; errField?: string } // no id: starting one
export interface SuggestState extends PanelState { p: "suggested"; back: PanelState; store?: number; vendor?: string; keys?: string[]; errField?: string }
export interface ReorderState extends ListState { p: "reorder"; store?: number; vendor?: string; errField?: string }
export interface VendorReturnState extends PanelState { p: "vreturn"; back: PanelState; token: string; errField?: string }
