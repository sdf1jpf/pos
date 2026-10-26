// A listing as a PDF: pages of fixed-width text on green-bar paper, in
// Courier, which every PDF reader has, so nothing is embedded. Written by
// hand: a report is only text, and this is all of PDF it needs.

const PAGE_W = 612; // US letter, in points
const PAGE_H = 792;
const SIZE = 9; // Courier 9 is 5.4 points a character
const LEAD = 11;
export const PAGE_LINES = 64;
const TOP = PAGE_H - 44;

// Characters the PDF string syntax treats specially, and anything outside
// printable ASCII, which Courier's standard encoding may not have.
const pdfText = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").replace(/[\\()]/g, (c) => `\\${c}`);

function pageStream(lines: string[], width: number): string {
	const left = Math.max((PAGE_W - width * SIZE * 0.6) / 2, 24);
	const right = PAGE_W - left;
	const out: string[] = [];
	// Green bars: three lines shaded, three not.
	out.push("0.85 0.94 0.84 rg");
	for (let i = 0; i < PAGE_LINES; i += 6) {
		const y = TOP - (i + 3) * LEAD - 3;
		out.push(`${(left - 6).toFixed(1)} ${(y - 3 * LEAD).toFixed(1)} ${(right - left + 12).toFixed(1)} ${(3 * LEAD).toFixed(1)} re f`);
	}
	out.push("0.11 0.11 0.11 rg", "BT", `/F1 ${SIZE} Tf`, `${LEAD} TL`, `${left.toFixed(1)} ${TOP} Td`);
	for (const l of lines) out.push(`(${pdfText(l)}) '`);
	out.push("ET");
	return out.join("\n");
}

// pdf makes a document of pages, each a list of lines no wider than width.
export function pdf(pages: string[][], width: number, title: string): Uint8Array {
	const objs: string[] = [];
	const add = (o: string) => objs.push(o); // its object number: they start at 1
	const catalog = add(""); // filled in below, once the page numbers are known
	const pagesObj = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
	const kids: number[] = [];
	for (const p of pages) {
		const body = pageStream(p, width);
		const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
		kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
	}
	objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
	objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	const info = add(`<< /Title (${pdfText(title)}) /Producer (Greenscreen POS) >>`);
	let doc = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(doc.length);
		doc += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = doc.length;
	doc += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) doc += `${String(o).padStart(10, "0")} 00000 n \n`;
	doc += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(doc);
}
