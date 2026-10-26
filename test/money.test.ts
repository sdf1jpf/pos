import { expect, it } from "vitest";
import { cents, dollars, parseRate, rate } from "../src/money";

it("reads and writes dollars", () => {
	expect(dollars(1234)).toBe("12.34");
	expect(dollars(-5)).toBe("-0.05");
	expect(cents("12")).toBe(1200);
	expect(cents("12.5")).toBe(1250);
	expect(cents("$1,200.05")).toBe(120005);
	expect(cents("1.234")).toBeUndefined();
	expect(cents("-1")).toBeUndefined();
});

it("reads and writes tax rates", () => {
	expect(rate(8250)).toBe("8.25");
	expect(rate(7000)).toBe("7.00");
	expect(rate(6125)).toBe("6.125");
	expect(parseRate("8.25")).toBe(8250);
	expect(parseRate("7%")).toBe(7000);
	expect(parseRate("6.1255")).toBeUndefined();
});
