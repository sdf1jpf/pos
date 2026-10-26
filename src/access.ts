// Who is signed on to the back office, and what they may do. Cloudflare
// Access says who a person is; the employee file says their role and
// stores. The userids in ADMIN_USERS are administrators of every store
// whether or not they are on file, so that the first person can sign on and
// add everyone else.

import type { Ctx } from "@greenscreen-dev/worker";
import { employeeByUserid, type Role } from "./data/employees";
import type { Env } from "./env";

export interface Who {
	userid: string;
	name: string;
	role: Role;
	stores: number[]; // the stores they are limited to; empty is every store
}

// What each role may do in the back office.
export type Right =
	| "items" // keep the item master and departments
	| "prices" // keep store price books
	| "stores" // keep stores and registers
	| "employees" // keep employees and their roles
	| "inventory" // on hand, adjustments, counts and transfers
	| "purchasing" // purchase orders, receiving, reorder points, returns to vendors
	| "endofday" // close the store's day, Z reports
	| "timeclock" // time cards and the schedule
	| "register"; // run a register from the back office

const RIGHTS: Record<Role, Right[]> = {
	CASHIER: [],
	SUPERVISOR: ["register"],
	MANAGER: ["prices", "inventory", "purchasing", "endofday", "timeclock", "register"],
	BUYER: ["items", "prices", "inventory", "purchasing"],
	ADMIN: ["items", "prices", "inventory", "purchasing", "endofday", "timeclock", "stores", "employees", "register"],
};

export function can(who: Who | undefined, right: Right): boolean {
	return !!who && RIGHTS[who.role].includes(right);
}

// canStore says whether a person may work on a store's records.
export function canStore(who: Who, store: number): boolean {
	return who.stores.length === 0 || who.stores.includes(store);
}

function admins(env: Env): string[] {
	return (env.ADMIN_USERS ?? "").split(/[\s,]+/).filter(Boolean).map((u) => u.toUpperCase());
}

// A screen asks who is signed on when it is handled and again when the next
// one is drawn; the answer is kept for the request.
const seen = new WeakMap<object, Promise<Who | undefined>>();

// who returns the signed-on person, or undefined if they may not use the
// back office.
export function who(ctx: Ctx<Env>): Promise<Who | undefined> {
	let w = seen.get(ctx);
	if (!w) {
		w = lookup(ctx);
		seen.set(ctx, w);
	}
	return w;
}

async function lookup(ctx: Ctx<Env>): Promise<Who | undefined> {
	const e = await employeeByUserid(ctx.env.DB, ctx.user);
	if (e && e.role !== "CASHIER") return { userid: ctx.user, name: e.name, role: e.role, stores: e.stores };
	if (admins(ctx.env).includes(ctx.user)) return { userid: ctx.user, name: ctx.user, role: "ADMIN", stores: [] };
	return undefined;
}
