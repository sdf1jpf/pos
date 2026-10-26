// Employees: who may sign on, as what, and at which stores.

import { audit, changed, Conflict, diff, Invalid, now, text, unique } from "./db";

export const ROLES = ["CASHIER", "SUPERVISOR", "MANAGER", "BUYER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export interface Employee {
	emp: number;
	name: string;
	role: Role;
	userid: string; // "" when the person has no back-office sign-on
	operator: string; // "" when the person has no register operator ID
	status: "A" | "I";
	stores: number[]; // the stores the person is limited to; empty is every store
	version: number;
	updatedAt: string;
	updatedBy: string;
}

export type EmployeeInput = Record<"name" | "role" | "userid" | "operator" | "status" | "stores", string>;

const COLS = `emp, name, role, COALESCE(userid, '') AS userid, COALESCE(operator, '') AS operator, status, version,
	updated_at AS updatedAt, updated_by AS updatedBy`;

async function withStores(db: D1Database, rows: Omit<Employee, "stores">[]): Promise<Employee[]> {
	if (rows.length === 0) return [];
	const links = (await db.prepare(`SELECT emp, store FROM employee_stores WHERE emp IN (${rows.map(() => "?").join(",")}) ORDER BY store`)
		.bind(...rows.map((r) => r.emp)).all<{ emp: number; store: number }>()).results;
	return rows.map((r) => ({ ...r, stores: links.filter((l) => l.emp === r.emp).map((l) => l.store) }));
}

export async function listEmployees(db: D1Database, offset: number, limit: number): Promise<{ employees: Employee[]; total: number }> {
	const [rows, count] = await db.batch<Omit<Employee, "stores"> | { n: number }>([
		db.prepare(`SELECT ${COLS} FROM employees ORDER BY name, emp LIMIT ? OFFSET ?`).bind(limit, offset),
		db.prepare("SELECT COUNT(*) AS n FROM employees"),
	]);
	return { employees: await withStores(db, rows.results as Omit<Employee, "stores">[]), total: (count.results[0] as { n: number }).n };
}

export async function getEmployee(db: D1Database, emp: number): Promise<Employee | undefined> {
	const r = await db.prepare(`SELECT ${COLS} FROM employees WHERE emp = ?`).bind(emp).first<Omit<Employee, "stores">>();
	return r ? (await withStores(db, [r]))[0] : undefined;
}

// employeeByUserid finds the active employee a back-office userid belongs to.
export async function employeeByUserid(db: D1Database, userid: string): Promise<Employee | undefined> {
	const r = await db.prepare(`SELECT ${COLS} FROM employees WHERE userid = ? AND status = 'A'`).bind(userid).first<Omit<Employee, "stores">>();
	return r ? (await withStores(db, [r]))[0] : undefined;
}

// checkEmployee turns what was typed into an employee's fields, or throws
// Invalid naming the field that is wrong.
export async function checkEmployee(db: D1Database, inp: EmployeeInput): Promise<Omit<Employee, "emp" | "version" | "updatedAt" | "updatedBy">> {
	const name = text(inp.name, 30);
	if (!name) throw new Invalid("name", "NAME IS REQUIRED");
	const role = text(inp.role, 10) as Role;
	if (!ROLES.includes(role)) throw new Invalid("role", "ROLE MUST BE CASHIER, SUPERVISOR, MANAGER, BUYER OR ADMIN");
	const userid = text(inp.userid, 8);
	if (userid && !/^[A-Z0-9]{1,8}$/.test(userid)) throw new Invalid("userid", "USERID MUST BE 1 TO 8 LETTERS OR DIGITS");
	const operator = inp.operator.trim();
	if (operator && !/^\d{3,6}$/.test(operator)) throw new Invalid("operator", "OPERATOR ID MUST BE 3 TO 6 DIGITS");
	const status = text(inp.status, 1) || "A";
	if (status !== "A" && status !== "I") throw new Invalid("status", "STATUS MUST BE A (ACTIVE) OR I (INACTIVE)");
	const words = inp.stores.split(/[\s,]+/).filter(Boolean);
	const stores = [...new Set(words.map(Number))].sort((a, b) => a - b);
	if (words.some((w) => !/^\d{1,3}$/.test(w))) throw new Invalid("stores", "STORES MUST BE STORE NUMBERS, E.G. 1,3 - BLANK FOR ALL");
	if (stores.length > 0) {
		const known = (await db.prepare(`SELECT store FROM stores WHERE store IN (${stores.map(() => "?").join(",")})`)
			.bind(...stores).all<{ store: number }>()).results.map((r) => r.store);
		const missing = stores.find((s) => !known.includes(s));
		if (missing !== undefined) throw new Invalid("stores", `STORE ${missing} NOT FOUND`);
	}
	return { name, role, userid, operator, status, stores };
}

async function taken(db: D1Database, e: { userid: string; operator: string }, emp: number): Promise<void> {
	if (e.userid && await db.prepare("SELECT 1 FROM employees WHERE userid = ? AND emp <> ?").bind(e.userid, emp).first()) {
		throw new Invalid("userid", `USERID ${e.userid} BELONGS TO ANOTHER EMPLOYEE`);
	}
	if (e.operator && await db.prepare("SELECT 1 FROM employees WHERE operator = ? AND emp <> ?").bind(e.operator, emp).first()) {
		throw new Invalid("operator", `OPERATOR ID ${e.operator} BELONGS TO ANOTHER EMPLOYEE`);
	}
}

const storeLinks = (db: D1Database, emp: number | null, stores: number[]) =>
	stores.map((s) => db.prepare(`INSERT INTO employee_stores (emp, store) VALUES (${emp === null ? "(SELECT MAX(emp) FROM employees)" : "?"}, ?)`)
		.bind(...(emp === null ? [s] : [emp, s])));

export async function addEmployee(db: D1Database, userid: string, inp: EmployeeInput): Promise<Employee> {
	const e = await checkEmployee(db, inp);
	await taken(db, e, 0);
	const at = now();
	// The batch is one transaction, so the employee just added is the one
	// with the highest number when their stores are linked.
	const results = await unique(db.batch([
		db.prepare("INSERT INTO employees (name, role, userid, operator, status, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING emp")
			.bind(e.name, e.role, e.userid || null, e.operator || null, e.status, at, userid),
		...storeLinks(db, null, e.stores),
		audit(db, userid, { action: "EMP.ADD", subject: e.name, detail: `role=${e.role} userid=${e.userid} stores=${e.stores.join(",")}` }, at),
	]), new Invalid("userid", "USERID OR OPERATOR ID BELONGS TO ANOTHER EMPLOYEE"));
	const emp = (results[0].results[0] as { emp: number }).emp;
	return (await getEmployee(db, emp))!;
}

export async function updateEmployee(db: D1Database, userid: string, emp: number, version: number, inp: EmployeeInput): Promise<Employee> {
	const e = await checkEmployee(db, inp);
	const before = await getEmployee(db, emp);
	if (!before || before.version !== version) throw new Conflict(`EMPLOYEE ${emp} WAS CHANGED BY ${before?.updatedBy ?? "SOMEONE"} - REVIEW AND RETRY`);
	await taken(db, e, emp);
	const at = now();
	const [upd] = await unique(db.batch([
		db.prepare(`UPDATE employees SET name = ?, role = ?, userid = ?, operator = ?, status = ?, version = version + 1,
			updated_at = ?, updated_by = ? WHERE emp = ? AND version = ?`)
			.bind(e.name, e.role, e.userid || null, e.operator || null, e.status, at, userid, emp, version),
		db.prepare("DELETE FROM employee_stores WHERE emp = ?").bind(emp),
		...storeLinks(db, emp, e.stores),
		audit(db, userid, {
			action: "EMP.UPDATE", subject: String(emp),
			detail: diff({ ...before, stores: before.stores.join(",") }, { ...before, ...e, stores: e.stores.join(",") },
				["name", "role", "userid", "operator", "status", "stores"]),
		}, at),
	]), new Invalid("userid", "USERID OR OPERATOR ID BELONGS TO ANOTHER EMPLOYEE"));
	if (changed(upd) === 0) throw new Conflict(`EMPLOYEE ${emp} WAS CHANGED BY SOMEONE ELSE - REVIEW AND RETRY`);
	return (await getEmployee(db, emp))!;
}
