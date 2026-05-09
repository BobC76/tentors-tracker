// Unified pipeline: extract PDF image, trace route, build waypoints, project to GeoJSON.
// Usage: node scripts/build-route.mjs <letter> [pdf-filename]
//
// Outputs go to routes/<LETTER>/:
//   waypoints.json, route-pixels.json, route.geojson, image-bounds.json, map.png

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import proj4 from "proj4";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

const LETTER = (process.argv[2] || "").toUpperCase();
if (!LETTER.match(/^[A-J]$/)) {
  console.error("Usage: node scripts/build-route.mjs <A-J> [pdf-file]");
  process.exit(1);
}

const ROOT = process.cwd();
const OUT = path.join(ROOT, "routes", LETTER);
await fs.mkdir(OUT, { recursive: true });

// --- Resolve PDF ---
let pdfPath = process.argv[3];
if (!pdfPath) {
  const files = await fs.readdir(ROOT);
  const match = files.find((f) => f.toLowerCase().includes(`route ${LETTER.toLowerCase()}`) && f.endsWith(".pdf"))
    || files.find((f) => f.toLowerCase().includes(`route-${LETTER.toLowerCase()}`) && f.endsWith(".pdf"))
    || files.find((f) => f.toLowerCase().includes(`route${LETTER.toLowerCase()}`) && f.endsWith(".pdf"));
  if (!match) { console.error(`No PDF found for route ${LETTER}`); process.exit(1); }
  pdfPath = path.join(ROOT, match);
} else {
  pdfPath = path.resolve(pdfPath);
}
console.log(`Route ${LETTER}: PDF = ${path.basename(pdfPath)}`);

// --- Step 1: Build waypoints from routes.json ---
console.log("\n=== Step 1: Build waypoints ===");
const routes = JSON.parse(await fs.readFile(path.join(ROOT, "routes.json"), "utf-8"));
const routeData = routes[LETTER];
if (!routeData) { console.error(`Route ${LETTER} not found in routes.json`); process.exit(1); }
const waypoints = routeData.waypoints.filter((w) => w.lat != null);
await fs.writeFile(path.join(OUT, "waypoints.json"), JSON.stringify(waypoints, null, 2));
console.log(`  ${waypoints.length} waypoints written`);

// --- Step 2: Extract map image from PDF ---
console.log("\n=== Step 2: Extract map image from PDF ===");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfData = new Uint8Array(await fs.readFile(pdfPath));
const pdf = await pdfjs.getDocument({ data: pdfData }).promise;
const page = await pdf.getPage(1);
const ops = await page.getOperatorList();
const fnNames = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));

const imageNames = [];
for (let i = 0; i < ops.fnArray.length; i++) {
  if (fnNames[ops.fnArray[i]] === "paintImageXObject") imageNames.push(ops.argsArray[i][0]);
  if (fnNames[ops.fnArray[i]] === "dependency") {
    for (const n of ops.argsArray[i]) imageNames.push(n);
  }
}

async function getObj(name) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    page.objs.get(name, (obj) => { clearTimeout(timer); resolve(obj); });
  });
}

let mapImg = null, mapName = null;
for (const name of [...new Set(imageNames)]) {
  const obj = await getObj(name);
  if (!obj || !obj.data) continue;
  const { width, height, kind, data: pixels } = obj;
  if (width < 500 || height < 500) continue; // skip small images
  console.log(`  ${name}: ${width}×${height}, kind=${kind}`);
  let img;
  if (kind === 2) img = sharp(Buffer.from(pixels), { raw: { width, height, channels: 3 } });
  else if (kind === 3) img = sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } });
  else if (kind === 1) img = sharp(Buffer.from(pixels), { raw: { width, height, channels: 1 } });
  else continue;
  const mapPath = path.join(OUT, "map.png");
  await img.png().toFile(mapPath);
  mapImg = { width, height, pixels, kind };
  mapName = name;
  console.log(`  → ${mapPath}`);
}
if (!mapImg) { console.error("No map image found in PDF"); process.exit(1); }

// --- Step 3: Trace route ---
console.log("\n=== Step 3: Trace red route line ===");
const IMG = path.join(OUT, "map.png");
const { data: pixels, info } = await sharp(IMG).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
console.log(`  Image: ${W}×${H}`);

const mask = (() => {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (r >= 110 && r <= 210 && g <= 60 && r - g >= 90 && r - b >= 30) m[y * W + x] = 1;
  }
  return m;
})();
console.log(`  Mask: ${mask.reduce((a, v) => a + v, 0)} px`);

function dilate(src, radius) {
  let cur = src;
  for (let r = 0; r < radius; r++) {
    const a = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      a[i] = cur[i] || (x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || 0;
    }
    const b = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      b[i] = a[i] || (y > 0 && a[i - W]) || (y < H - 1 && a[i + W]) || 0;
    }
    cur = b;
  }
  return cur;
}

function components(mask) {
  const labels = new Int32Array(W * H);
  const sizes = [0]; const bbox = [null];
  const stack = new Int32Array(W * H);
  let next = 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (!mask[idx] || labels[idx]) continue;
    let top = 0; stack[top++] = idx; labels[idx] = next; let size = 0;
    let x0 = x, y0 = y, x1 = x, y1 = y;
    while (top) {
      const p = stack[--top]; size++;
      const py = (p / W) | 0, px = p - py * W;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (mask[ni] && !labels[ni]) { labels[ni] = next; stack[top++] = ni; }
      }
    }
    sizes.push(size); bbox.push({ x0, y0, x1, y1 }); next++;
  }
  return { labels, sizes, bbox };
}

console.log("  Dilating (16px)...");
const dilated = dilate(mask, 16);

console.log("  Finding components...");
const cc = components(dilated);
let bestLbl = 0, bestArea = 0;
for (let lbl = 1; lbl < cc.sizes.length; lbl++) {
  const bb = cc.bbox[lbl];
  const area = (bb.x1 - bb.x0) * (bb.y1 - bb.y0);
  if (area > bestArea) { bestArea = area; bestLbl = lbl; }
}
const routeMask = new Uint8Array(W * H);
for (let i = 0; i < cc.labels.length; i++) if (cc.labels[i] === bestLbl) routeMask[i] = 1;
console.log(`  Route component: label ${bestLbl}, ${cc.sizes[bestLbl]} px`);

console.log("  Tracing contour...");
function trace(mask) {
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y * W + x]) { sx = x; sy = y; break outer; }
  }
  if (sx < 0) return [];
  const D = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  let cx = sx, cy = sy, backtrack = 4;
  const pts = [[cx, cy]];
  for (let safety = 0; safety < W * H * 2; safety++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (backtrack + k) % 8;
      const [dx, dy] = D[d];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!mask[ny * W + nx]) continue;
      cx = nx; cy = ny; pts.push([cx, cy]); backtrack = (d + 4) % 8; found = true; break;
    }
    if (!found) break;
    if (pts.length > 3 && cx === sx && cy === sy) break;
  }
  return pts;
}
const contour = trace(routeMask);
console.log(`  Contour: ${contour.length} pixels`);

function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  function perpDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    let maxD = 0, maxK = -1;
    for (let k = i0 + 1; k < i1; k++) {
      const d = perpDist(points[k], points[i0], points[i1]);
      if (d > maxD) { maxD = d; maxK = k; }
    }
    if (maxD > eps && maxK > 0) { keep[maxK] = 1; stack.push([i0, maxK]); stack.push([maxK, i1]); }
  }
  return points.filter((_, i) => keep[i]);
}
const decimated = rdp(contour, 4);
console.log(`  Decimated: ${decimated.length} points`);

await fs.writeFile(
  path.join(OUT, "route-pixels.json"),
  JSON.stringify({ width: W, height: H, points: decimated }, null, 2)
);

// --- Step 4: Project to GeoJSON ---
console.log("\n=== Step 4: Project to GeoJSON ===");
const routePixels = { width: W, height: H, points: decimated };

let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity;
for (const [x, y] of routePixels.points) {
  if (x < pxMin) pxMin = x; if (x > pxMax) pxMax = x;
  if (y < pyMin) pyMin = y; if (y > pyMax) pyMax = y;
}
let eMin = Infinity, eMax = -Infinity, nMin = Infinity, nMax = -Infinity;
for (const w of waypoints) {
  const [E, N] = proj4("EPSG:4326", "EPSG:27700", [w.lon, w.lat]);
  if (E < eMin) eMin = E; if (E > eMax) eMax = E;
  if (N < nMin) nMin = N; if (N > nMax) nMax = N;
}
const DIL_M = 16 * 4.17;
const eMinC = eMin - DIL_M, eMaxC = eMax + DIL_M;
const nMinC = nMin - DIL_M, nMaxC = nMax + DIL_M;

function pxToLatLon(x, y) {
  const E = eMinC + (x - pxMin) / (pxMax - pxMin) * (eMaxC - eMinC);
  const N = nMaxC - (y - pyMin) / (pyMax - pyMin) * (nMaxC - nMinC);
  const [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [E, N]);
  return [lon, lat];
}

const rawProjected = routePixels.points.map(([x, y]) => pxToLatLon(x, y));
const SHIFT_M = 16 * 4.17;
const projected = rawProjected.map((cur, i) => {
  const prev = rawProjected[(i - 1 + rawProjected.length) % rawProjected.length];
  const nxt = rawProjected[(i + 1) % rawProjected.length];
  const cosLat = Math.cos(cur[1] * Math.PI / 180);
  const tx = (nxt[0] - prev[0]) * cosLat * 111000;
  const ty = (nxt[1] - prev[1]) * 111000;
  const len = Math.hypot(tx, ty) || 1;
  const nx = ty / len * SHIFT_M;
  const ny = -tx / len * SHIFT_M;
  return [cur[0] + nx / (cosLat * 111000), cur[1] + ny / 111000];
});

function dist(a, b) {
  const dy = a[1] - b[1];
  const dx = (a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot(dx, dy);
}
const wpAnchors = waypoints.map((w) => {
  let bestI = -1, bestD = Infinity;
  const wpLL = [w.lon, w.lat];
  for (let i = 0; i < projected.length; i++) {
    const d = dist(projected[i], wpLL);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return { label: w.label, lat: w.lat, lon: w.lon, contourIdx: bestI, distDeg: bestD };
});
console.log("  Waypoint anchors:");
for (const a of wpAnchors) {
  console.log(`    ${a.label.padEnd(18)} idx=${a.contourIdx}, dist≈${(a.distDeg * 111000).toFixed(0)} m`);
}

const sortedByIdx = wpAnchors.slice().sort((a, b) => a.contourIdx - b.contourIdx);
const N = projected.length;
const cycleAnchors = sortedByIdx.map((a) => ({
  ...a,
  drift: [a.lon - projected[a.contourIdx][0], a.lat - projected[a.contourIdx][1]],
}));
const wrappedAnchors = cycleAnchors.concat(
  cycleAnchors.map((a) => ({ ...a, contourIdx: a.contourIdx + N }))
);

const corrected = new Array(N);
let aIdx = 0;
for (let i = 0; i < N; i++) {
  while (aIdx + 1 < wrappedAnchors.length && wrappedAnchors[aIdx + 1].contourIdx <= i) aIdx++;
  const A = wrappedAnchors[aIdx];
  const B = wrappedAnchors[aIdx + 1] ?? A;
  let t = 0;
  if (B.contourIdx > A.contourIdx) t = (i - A.contourIdx) / (B.contourIdx - A.contourIdx);
  corrected[i] = [
    projected[i][0] + A.drift[0] + t * (B.drift[0] - A.drift[0]),
    projected[i][1] + A.drift[1] + t * (B.drift[1] - A.drift[1]),
  ];
}
for (const a of cycleAnchors) corrected[a.contourIdx] = [a.lon, a.lat];

const anchorSet = new Set(cycleAnchors.map((a) => a.contourIdx));
let smoothed = corrected.map((p) => p.slice());
for (let it = 0; it < 2; it++) {
  const next = smoothed.map((p) => p.slice());
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue;
    const prev = smoothed[(i - 1 + N) % N];
    const nx = smoothed[(i + 1) % N];
    next[i] = [(prev[0] + nx[0]) * 0.5, (prev[1] + nx[1]) * 0.5];
  }
  smoothed = next;
}
smoothed.push(smoothed[0]);

const geojson = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "LineString", coordinates: smoothed },
    properties: {
      source: `Ten Tors 2026 Route ${LETTER} PDF (pixel trace, anchored to waypoints)`,
      anchors: cycleAnchors.length,
    },
  }],
};
await fs.writeFile(path.join(OUT, "route.geojson"), JSON.stringify(geojson));
console.log(`  route.geojson: ${smoothed.length} points, ${cycleAnchors.length} anchors`);

const corners = {
  topLeft:     pxToLatLon(0, 0),
  topRight:    pxToLatLon(routePixels.width, 0),
  bottomLeft:  pxToLatLon(0, routePixels.height),
  bottomRight: pxToLatLon(routePixels.width, routePixels.height),
};
const south = Math.min(corners.bottomLeft[1], corners.bottomRight[1]);
const north = Math.max(corners.topLeft[1], corners.topRight[1]);
const west  = Math.min(corners.topLeft[0], corners.bottomLeft[0]);
const east  = Math.max(corners.topRight[0], corners.bottomRight[0]);
await fs.writeFile(path.join(OUT, "image-bounds.json"), JSON.stringify({
  imagePath: `routes/${LETTER}/map.png`,
  width: routePixels.width,
  height: routePixels.height,
  bounds: [[south, west], [north, east]],
  corners,
}, null, 2));
console.log("  image-bounds.json written");

console.log(`\n✓ Route ${LETTER} complete → ${OUT}/`);
process.exit(0);
