// Dump operator histogram for the PDF — figure out what's actually on the page.
import fs from "node:fs/promises";
import path from "node:path";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const data = new Uint8Array(await fs.readFile(path.join(process.cwd(), "Ten Tors 2026 - Route E - Barracudas.pdf")));
const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const page = await pdf.getPage(1);
const ops = await page.getOperatorList();
const fnNames = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));

const counts = {};
for (const fn of ops.fnArray) counts[fnNames[fn] ?? `?${fn}`] = (counts[fnNames[fn] ?? `?${fn}`] || 0) + 1;
console.log("Op histogram:");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
console.log("\nPage view:", page.view, " rotate:", page.rotate);
