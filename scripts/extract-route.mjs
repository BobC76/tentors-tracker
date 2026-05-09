// Extract the red route polyline from the Route E PDF.
// Strategy:
//   1. Use pdfjs-dist to walk operators on page 1.
//   2. Track current graphics state (transform matrix + stroke colour).
//   3. Collect points from path-construction ops (moveTo/lineTo/curveTo) on
//      strokes whose colour is reddish (R high, G/B low).
//   4. The PDF's user-space matches the OS grid (in metres or km) up to an
//      affine transform — fit it using known waypoint grid refs and reproject
//      the polyline into OSGB easting/northing → WGS84 lat/lon.

import fs from "node:fs/promises";
import path from "node:path";
import proj4 from "proj4";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const PDF_PATH = path.join(process.cwd(), "Ten Tors 2026 - Route E - Barracudas.pdf");
const data = new Uint8Array(await fs.readFile(PDF_PATH));
const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
console.log(`PDF: ${pdf.numPages} page(s)`);

const page = await pdf.getPage(1);
const ops = await page.getOperatorList();
const fnNames = Object.fromEntries(
  Object.entries(pdfjs.OPS).map(([k, v]) => [v, k])
);

// --- Walk operators ---
// Track CTM stack and current stroke colour.
function multiply(a, b) {
  // 2D affine 3x3 stored as [a, b, c, d, e, f] (column-major-ish PDF convention).
  // x' = a*x + c*y + e ; y' = b*x + d*y + f
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function applyMatrix(m, [x, y]) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

let ctm = [1, 0, 0, 1, 0, 0];
const ctmStack = [];
let strokeRGB = [0, 0, 0];
const colourStack = [];

const polylines = []; // [{ rgb, points: [[x,y],...] }]
let currentPath = null; // { points, startedAt }

function startPath() { currentPath = { points: [], rgb: strokeRGB.slice() }; }
function ensurePath() { if (!currentPath) startPath(); return currentPath; }

let opIdx = 0;
for (const fn of ops.fnArray) {
  const args = ops.argsArray[opIdx++];
  switch (fnNames[fn]) {
    case "save": ctmStack.push(ctm); colourStack.push(strokeRGB); break;
    case "restore":
      ctm = ctmStack.pop() ?? ctm;
      strokeRGB = colourStack.pop() ?? strokeRGB;
      break;
    case "transform":
      // args: [a,b,c,d,e,f]
      ctm = multiply(ctm, args);
      break;
    case "setStrokeRGBColor": {
      // pdfjs gives a hex string like "#ff0000" or array — handle both.
      const v = args[0];
      if (typeof v === "string" && v.startsWith("#")) {
        strokeRGB = [
          parseInt(v.slice(1, 3), 16) / 255,
          parseInt(v.slice(3, 5), 16) / 255,
          parseInt(v.slice(5, 7), 16) / 255,
        ];
      } else if (Array.isArray(v)) {
        strokeRGB = [v[0], v[1], v[2]];
      }
      break;
    }
    case "setStrokeColorN":
    case "setStrokeColor": {
      // Generic stroke colour — interpret as RGB if 3 components.
      if (args.length >= 3) strokeRGB = [args[0], args[1], args[2]];
      break;
    }
    case "moveTo": {
      const p = applyMatrix(ctm, args);
      // Start a new sub-path; if previous had points, keep it.
      if (currentPath && currentPath.points.length > 1) {
        polylines.push(currentPath);
      }
      currentPath = { points: [p], rgb: strokeRGB.slice() };
      break;
    }
    case "lineTo": {
      const p = applyMatrix(ctm, args);
      ensurePath().points.push(p);
      break;
    }
    case "curveTo":
    case "curveTo2":
    case "curveTo3": {
      // Sample the cubic at the endpoint only (good enough for our purposes
      // — the PDF uses many short segments, so this still gives plenty of
      // detail).
      const x = args[args.length - 2];
      const y = args[args.length - 1];
      ensurePath().points.push(applyMatrix(ctm, [x, y]));
      break;
    }
    case "rectangle": {
      const [x, y, w, h] = args;
      const corners = [
        [x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y],
      ];
      currentPath = { points: corners.map((p) => applyMatrix(ctm, p)), rgb: strokeRGB.slice() };
      break;
    }
    case "stroke":
    case "closeStroke":
    case "fillStroke":
    case "eoFillStroke":
    case "closeFillStroke":
    case "closeEOFillStroke": {
      if (currentPath && currentPath.points.length > 1) {
        polylines.push(currentPath);
      }
      currentPath = null;
      break;
    }
    case "endPath":
    case "fill":
    case "eoFill":
    case "closePath":
      // No-op for our extraction.
      break;
    default:
      break;
  }
}
if (currentPath && currentPath.points.length > 1) polylines.push(currentPath);

console.log(`Extracted ${polylines.length} stroked sub-paths`);

// --- Filter for the red route ---
function isRouteRed([r, g, b]) {
  return r > 0.55 && g < 0.35 && b < 0.35;
}
const reds = polylines.filter((p) => isRouteRed(p.rgb));
console.log(`Red-stroked sub-paths: ${reds.length}`);
if (!reds.length) {
  console.log("Stroke colours seen:", [...new Set(polylines.map(p => p.rgb.map(v=>v.toFixed(2)).join(",")))].slice(0,20));
  process.exit(2);
}

// Pick the longest red polyline (the main route line).
reds.sort((a, b) => b.points.length - a.points.length);
const route = reds[0];
console.log(`Main route: ${route.points.length} points`);

// --- Fit affine PDF → OSGB ---
// We have known waypoint grid refs (build-waypoints.mjs), and the route passes
// through each. For each waypoint, find the route point closest to it in PDF
// space (after a rough scaling), then solve for the affine that best maps PDF
// coords to OSGB metres.
//
// Bootstrap: assume the page roughly covers the SX 53-66 / 75-94 grid block
// (13 km × 19 km, displayed in some PDF size). Find page bounds from route
// extents, pick first/last route points to anchor approximately, then refine
// against waypoints.

const gridRefs = {
  START:            { gr: "SX 5878 9262" },  // OKE CAMP
  "OKE TOR":        { gr: "SX 6131 8978" },
  "OKEMENT HILL":   { gr: "SX 6026 8775" },
  "WATERN TOR":     { gr: "SX 6290 8690" },
  "FERNWORTHY":     { gr: "SX 6407 8432" },
  "SITTAFORD TOR":  { gr: "SX 6335 8305" },
  "WATER HILL":     { gr: "SX 6714 8128" },
  "POSTBRIDGE":     { gr: "SX 6460 7879" },
  "HIGHER WHITE TOR":{gr: "SX 6180 7860" },
  "HOLMING BEAM":   { gr: "SX 5914 7646" },
  "WHITE BARROW":   { gr: "SX 5685 7931" },
  "STANDON FARM":   { gr: "SX 5450 8146" },
  "HARE TOR":       { gr: "SX 5512 8428" },
  "NODDEN GATE":    { gr: "SX 5300 8632" },
  "KITTY TOR":      { gr: "SX 5673 8744" },
  "EAST MILL TOR":  { gr: "SX 5994 8987" },
  FINISH:           { gr: "SX 5878 9262" },
};

function gridToEN(gr) {
  const m = gr.replace(/\s+/g, "").match(/^SX(\d+)$/);
  if (!m) throw new Error("bad gr: " + gr);
  const d = m[1]; const half = d.length / 2;
  const e = parseInt(d.slice(0, half).padEnd(5, "0"), 10);
  const n = parseInt(d.slice(half).padEnd(5, "0"), 10);
  return [200000 + e, 0 + n];
}

// Save raw PDF-space route + per-waypoint grid points so we can solve fit
// in a follow-up step (after inspecting bounds).
const xs = route.points.map(p => p[0]);
const ys = route.points.map(p => p[1]);
const bbox = {
  minX: Math.min(...xs), maxX: Math.max(...xs),
  minY: Math.min(...ys), maxY: Math.max(...ys),
};
console.log("PDF route bbox:", bbox);

await fs.writeFile(
  path.join(process.cwd(), "route-pdf-raw.json"),
  JSON.stringify({ points: route.points, bbox, rgb: route.rgb }, null, 2)
);
console.log("Wrote route-pdf-raw.json");
