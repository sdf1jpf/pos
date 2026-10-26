// Money is kept in cents and tax rates in thousandths of a percent.

// dollars formats cents: 1234 -> "12.34", -5 -> "-0.05".
export function dollars(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const c = Math.abs(Math.round(cents));
	return `${sign}${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

// cents reads an amount typed as dollars ("12", "12.5", "12.34", "$1,200"),
// or returns undefined.
export function cents(s: string): number | undefined {
	const m = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim().replace(/,/g, ""));
	if (!m) return undefined;
	return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

// rate formats a tax rate: 8250 -> "8.25", 7000 -> "7.00", 6125 -> "6.125".
export function rate(milli: number): string {
	const s = `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, "0")}`;
	return s.endsWith("0") ? s.slice(0, -1) : s;
}

// parseRate reads a percentage typed with up to three decimals ("8.25",
// "7", "6.125%"), or returns undefined.
export function parseRate(s: string): number | undefined {
	const m = /^(\d{1,2})(?:\.(\d{1,3}))?%?$/.exec(s.trim());
	if (!m) return undefined;
	return Number(m[1]) * 1000 + Number((m[2] ?? "0").padEnd(3, "0"));
}
