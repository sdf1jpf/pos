import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addDays, monday, readShift, shiftMinutes } from "../src/data/timeclock";
import { map, terminal, text, value } from "./terminal";

const punches = async (emp: number) =>
	(await env.DB.prepare("SELECT id, store, reg, in_at AS inAt, out_at AS outAt, edited_by AS editedBy, note FROM punches WHERE emp = ? ORDER BY in_at").bind(emp).all<{
		id: number; store: number; reg: number | null; inAt: string; outAt: string | null; editedBy: string | null; note: string;
	}>()).results;

const today = () => new Date().toISOString().slice(0, 10);

describe("time clock", () => {
	it("reads shifts and weeks", () => {
		expect(readShift("9-17")).toEqual({ starts: "09:00", ends: "17:00" });
		expect(readShift("0930-1730")).toEqual({ starts: "09:30", ends: "17:30" });
		expect(readShift("930-1730")).toEqual({ starts: "09:30", ends: "17:30" });
		expect(readShift("22:00-06:00")).toEqual({ starts: "22:00", ends: "06:00" });
		expect(readShift("")).toBeNull();
		expect(readShift("25-17")).toBeUndefined();
		expect(readShift("9-9")).toBeUndefined();
		expect(shiftMinutes("22:00", "06:00")).toBe(480);
		expect(monday("2026-10-26")).toBe("2026-10-26");
		expect(monday("2026-11-01")).toBe("2026-10-26");
		expect(monday("2026-10-28")).toBe("2026-10-26");
	});

	it("clocks people in and out at the register, and a manager fixes their punches", async () => {
		// Casey clocks in at register 1, from the sign-on screen.
		const t = terminal("SUPER");
		await t.key("START");
		await t.key("ENTER", { option: "R" });
		let r = await t.key("ENTER", { store: "1", reg: "1" });
		expect(text(r)).toContain("PF9=CLOCK IN/OUT");
		r = await t.key("PF9", { operator: "3001", pin: "9999" });
		expect(text(r)).toContain("POS2104E");
		r = await t.key("PF9", { operator: "3001", pin: "1234" });
		expect(map(r)).toBe("POS210");
		expect(text(r)).toMatch(/POS2112I CASEY CASHIER CLOCKED IN AT \d\d:\d\d/);
		let p = await punches(3);
		expect(p).toHaveLength(1);
		expect(p[0]).toMatchObject({ store: 1, reg: 1, outAt: null });
		r = await t.key("PF9", { operator: "3001", pin: "1234" });
		expect(text(r)).toMatch(/POS2113I CASEY CASHIER CLOCKED OUT AT \d\d:\d\d - 0.00 HOURS/);
		expect((await punches(3))[0].outAt).not.toBeNull();
		await t.key("PF3");

		// The manager of store 2 can't see store 1's time cards.
		const m = terminal("MANAGER");
		await m.key("START");
		r = await m.key("ENTER", { option: "4" });
		expect(text(r)).toContain("TIME CARDS");
		expect(text(r)).not.toContain("People and roles");
		r = await m.key("ENTER", { option: "2" });
		expect(map(r)).toBe("POS420");
		r = await m.key("ENTER", { store: "1" });
		expect(text(r)).toContain("POS4201E YOU MAY NOT WORK ON STORE 1");

		// An admin fixes Casey's punch: it was last Tuesday, 8 to noon.
		const a = terminal("ADMIN");
		await a.key("START");
		r = await a.key("ENTER", { option: "4.2" });
		r = await a.key("ENTER", { store: "1" });
		expect(text(r)).toContain("CASEY CASHIE");
		r = await a.key("ENTER", { "sel:3": "S" });
		expect(map(r)).toBe("POS421");
		const id = (await punches(3))[0].id;
		const day = addDays(monday(today()), -6);
		r = await a.key("ENTER", { [`in:${id}`]: `${day} 08:00`, [`out:${id}`]: `${day} 12:00` });
		expect(text(r)).toContain("POS4211E KEY A REASON");
		expect(value(r, `in:${id}`)).toBe(`${day} 08:00`);
		r = await a.key("ENTER", { [`in:${id}`]: `${day} 08:00`, [`out:${id}`]: `${day} 07:00`, reason: "forgot" });
		expect(text(r)).toContain("OUT MUST BE AFTER IN");
		r = await a.key("ENTER", { [`in:${id}`]: `${day} 08:00`, [`out:${id}`]: `${day} 12:00`, reason: "forgot to punch" });
		expect(text(r)).toContain("POS4213I 1 CHANGE(S) SAVED");
		expect(text(r)).toContain("WORKED 0.00"); // it moved to last week
		p = await punches(3);
		expect(p[0]).toMatchObject({ inAt: `${day}T08:00:00.000Z`, outAt: `${day}T12:00:00.000Z`, editedBy: "ADMIN", note: "FORGOT TO PUNCH" });

		// Last week: an overlapping punch is refused; one after lunch is added.
		await a.key("PF3");
		r = await a.key("PF4");
		expect(text(r)).toContain("4.00");
		r = await a.key("ENTER", { "sel:3": "S" });
		expect(text(r)).toContain("WORKED 4.00");
		r = await a.key("ENTER", { "in:new": `${day} 11:00`, "out:new": `${day} 12:30`, reason: "lunch" });
		expect(text(r)).toContain(`OVERLAPS ANOTHER PUNCH (${id})`);
		r = await a.key("ENTER", { "in:new": `${day} 12:30`, "out:new": `${day} 13:00`, reason: "after lunch" });
		expect(text(r)).toContain("1 CHANGE(S) SAVED");
		expect(text(r)).toContain("WORKED 4.50");
		const late = (await punches(3))[1].id;
		r = await a.key("ENTER", { [`sel:${late}`]: "D", reason: "mistake" });
		expect(text(r)).toContain("1 CHANGE(S) SAVED");
		expect(text(r)).toContain("WORKED 4.00");
		expect(await punches(3)).toHaveLength(1);
		const log = await env.DB.prepare("SELECT action FROM audit WHERE action LIKE 'TIME.%' ORDER BY id").all();
		expect(log.results.map((x) => x.action)).toEqual(["TIME.IN", "TIME.OUT", "TIME.EDIT", "TIME.ADD", "TIME.DELETE"]);
	});

	it("keeps the week's schedule and copies it forward", async () => {
		const a = terminal("ADMIN");
		await a.key("START");
		let r = await a.key("ENTER", { option: "4.3" });
		expect(map(r)).toBe("POS430");
		r = await a.key("ENTER", { store: "1", week: "2026-11-04" });
		expect(value(r, "week")).toBe("2026-11-02");
		expect(text(r)).toContain("MON 11/02");
		expect(text(r)).toContain("CASEY CASHIER");
		r = await a.key("ENTER", { "sh:3:0": "9-17", "sh:3:1": "nine" });
		expect(text(r)).toContain("POS4302E");
		r = await a.key("ENTER", { "sh:3:0": "9-17", "sh:3:1": "1200-2030", "sh:5:6": "22-6" });
		expect(text(r)).toContain("POS4303I 3 SHIFT(S) SAVED");
		expect(value(r, "sh:3:0")).toBe("0900-1700");
		expect(text(r)).toContain("16.50");

		// Next week, copied, with Monday off.
		r = await a.key("PF5");
		expect(value(r, "week")).toBe("2026-11-09");
		r = await a.key("PF6");
		expect(text(r)).toContain("POS4304I 3 SHIFT(S) COPIED");
		expect(value(r, "sh:3:1")).toBe("1200-2030");
		r = await a.key("ENTER", { "sh:3:0": "" });
		expect(text(r)).toContain("1 SHIFT(S) SAVED");
		const rows = await env.DB.prepare("SELECT emp, day, starts, ends FROM shifts WHERE store = 1 ORDER BY day, emp").all();
		expect(rows.results).toEqual([
			{ emp: 3, day: "2026-11-02", starts: "09:00", ends: "17:00" },
			{ emp: 3, day: "2026-11-03", starts: "12:00", ends: "20:30" },
			{ emp: 5, day: "2026-11-08", starts: "22:00", ends: "06:00" },
			{ emp: 3, day: "2026-11-10", starts: "12:00", ends: "20:30" },
			{ emp: 5, day: "2026-11-15", starts: "22:00", ends: "06:00" },
		]);

		// Scheduled hours show on the time cards.
		await a.key("PF3");
		r = await a.key("ENTER", { option: "4.2" });
		r = await a.key("ENTER", { store: "1", week: "2026-11-02" });
		expect(text(r)).toContain("RILEY CASHIE");
		expect(text(r)).toContain("16.50");
	});
});
