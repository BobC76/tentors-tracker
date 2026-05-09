// Pull the embedded OS map raster from the PDF (img_p0_1, 3144×4540).
// pdfjs loads image XObjects into page.objs after operator list resolution.

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const data = new Uint8Array(await fs.readFile(path.join(process.cwd(), "Ten Tors 2026 - Route E - Barracudas.pdf")));
const pdf = await pdfjs.getDocument({ data }).promise;
const page = await pdf.getPage(1);
const ops = await page.getOperatorList();
const fnNames = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));

// Find image XObject names referenced by the page.
const imageNames = [];
for (let i = 0; i < ops.fnArray.length; i++) {
  if (fnNames[ops.fnArray[i]] === "paintImageXObject") imageNames.push(ops.argsArray[i][0]);
  if (fnNames[ops.fnArray[i]] === "dependency") {
    for (const n of ops.argsArray[i]) imageNames.push(n);
  }
}
const unique = [...new Set(imageNames)];
console.log("Image refs:", unique);

// page.objs has a get(name, callback). Wait for each.
async function getObj(name) {
  return new Promise((resolve) => {
    page.objs.get(name, (obj) => resolve(obj));
  });
}

for (const name of unique) {
  const obj = await getObj(name);
  if (!obj || !obj.data) {
    console.log(name, "→ no .data; keys:", obj && Object.keys(obj));
    continue;
  }
  const { width, height, kind, data: pixels } = obj;
  console.log(`${name}: ${width}×${height}, kind=${kind}, bytes=${pixels.length}`);

  // pdfjs ImageKind: 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP
  let img;
  if (kind === 2) {
    img = sharp(Buffer.from(pixels), { raw: { width, height, channels: 3 } });
  } else if (kind === 3) {
    img = sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } });
  } else if (kind === 1) {
    img = sharp(Buffer.from(pixels), { raw: { width, height, channels: 1 } });
  } else {
    console.log("  unknown kind, skipping");
    continue;
  }
  const out = path.join(process.cwd(), `${name}.png`);
  await img.png().toFile(out);
  console.log(`  → ${out}`);
}
