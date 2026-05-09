// Render PDF page 1 to a high-resolution PNG via pdfjs + @napi-rs/canvas.
import fs from "node:fs/promises";
import path from "node:path";
import { Canvas } from "@napi-rs/canvas";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

class NodeCanvasFactory {
  create(width, height) {
    const canvas = new Canvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; }
}

const data = new Uint8Array(await fs.readFile(path.join(process.cwd(), "Ten Tors 2026 - Route E - Barracudas.pdf")));
const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
const page = await pdf.getPage(1);

// Page is A4-ish at 0.072 dpi (PDF user units = 1/72 inch). Render at 300 dpi.
const scale = 300 / 72;
const viewport = page.getViewport({ scale });
console.log("Render size:", viewport.width, "x", viewport.height);

const factory = new NodeCanvasFactory();
const { canvas, context } = factory.create(viewport.width, viewport.height);
await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;

const png = canvas.toBuffer("image/png");
const outPath = path.join(process.cwd(), "route-page.png");
await fs.writeFile(outPath, png);
console.log(`Wrote ${outPath} (${(png.length / 1024 / 1024).toFixed(1)} MB)`);
