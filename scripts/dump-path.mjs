// constructPath bundles the entire path. Dump its structure.
import fs from "node:fs/promises";
import path from "node:path";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const data = new Uint8Array(await fs.readFile(path.join(process.cwd(), "Ten Tors 2026 - Route E - Barracudas.pdf")));
const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const page = await pdf.getPage(1);
const ops = await page.getOperatorList();
const OPS = pdfjs.OPS;
const fnNames = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));

let i = 0;
for (const fn of ops.fnArray) {
  const args = ops.argsArray[i++];
  const name = fnNames[fn];
  if (name === "setStrokeRGBColor") console.log("strokeRGB:", args);
  if (name === "transform") console.log("transform:", args);
  if (name === "constructPath") {
    console.log("\nconstructPath args:");
    console.log("  type of args[0]:", typeof args[0], Array.isArray(args[0]) ? `array(${args[0].length})` : Object.prototype.toString.call(args[0]));
    console.log("  args[0]:", args[0]);
    console.log("  type of args[1]:", typeof args[1], Array.isArray(args[1]) ? `array(${args[1].length})` : Object.prototype.toString.call(args[1]));
    if (Array.isArray(args[1])) console.log("  args[1] first 16:", args[1].slice(0, 16));
    if (args[2]) console.log("  args[2]:", args[2]);
  }
  if (name === "paintImageXObject") console.log("paintImageXObject args:", args);
  if (name === "setGState") console.log("setGState args:", args);
}
