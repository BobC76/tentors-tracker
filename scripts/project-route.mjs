// Project pixel-space route polyline to WGS84, anchored to all waypoints.
//
// Step 1: rough global pixel→OSGB affine from contour bbox vs route bbox
//         (with dilation offset). This may be off non-uniformly.
// Step 2: project each contour point to lat/lon.
// Step 3: for each waypoint, find the contour point nearest to it.
//         These contour indices should appear along the loop in route order.
// Step 4: piecewise drift correction — between two consecutive (in route
//         order) waypoint anchors, linearly interpolate the drift so the
//         contour passes through both waypoints exactly. This warps the
//         shape gently and preserves local detail.
// Step 5: light smoothing (moving average, small window) to remove the
//         small self-intersection without losing route character.
// Step 6: write route.geojson.

import fs from "node:fs/promises";
import path from "node:path";
import proj4 from "proj4";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

const route = JSON.parse(await fs.readFile("route-pixels.json", "utf-8"));
const waypoints = JSON.parse(await fs.readFile("waypoints.json", "utf-8"));

// --- Step 1: rough global affine (px → OSGB) ---
let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity;
for (const [x, y] of route.points) {
  if (x < pxMin) pxMin = x; if (x > pxMax) pxMax = x;
  if (y < pyMin) pyMin = y; if (y > pyMax) pyMax = y;
}
let eMin = Infinity, eMax = -Infinity, nMin = Infinity, nMax = -Infinity;
for (const w of waypoints) {
  const [E, N] = proj4("EPSG:4326", "EPSG:27700", [w.lon, w.lat]);
  if (E < eMin) eMin = E; if (E > eMax) eMax = E;
  if (N < nMin) nMin = N; if (N > nMax) nMax = N;
}
const DIL_M = 16 * 4.17; // dilation radius * m/px
const eMinC = eMin - DIL_M, eMaxC = eMax + DIL_M;
const nMinC = nMin - DIL_M, nMaxC = nMax + DIL_M;

function pxToLatLon(x, y) {
  const E = eMinC + (x - pxMin) / (pxMax - pxMin) * (eMaxC - eMinC);
  const N = nMaxC - (y - pyMin) / (pyMax - pyMin) * (nMaxC - nMinC);
  const [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [E, N]);
  return [lon, lat];
}

// --- Step 2: project all contour points ---
const rawProjected = route.points.map(([x, y]) => pxToLatLon(x, y));

// --- Step 2b: shift each point inward along the local normal by ~67 m to
// compensate for the 16 px outward dilation. Contour was traced clockwise in
// image y-down coords, which is also clockwise in lat-lon (lat-up): for a CW
// loop the interior is on the RIGHT of the direction of travel, so the
// inward normal is the tangent rotated 90° clockwise. ---
const SHIFT_M = 16 * 4.17;
const projected = rawProjected.map((cur, i) => {
  const prev = rawProjected[(i - 1 + rawProjected.length) % rawProjected.length];
  const nxt = rawProjected[(i + 1) % rawProjected.length];
  const cosLat = Math.cos(cur[1] * Math.PI / 180);
  // Tangent in metres (east, north).
  const tx = (nxt[0] - prev[0]) * cosLat * 111000;
  const ty = (nxt[1] - prev[1]) * 111000;
  const len = Math.hypot(tx, ty) || 1;
  // CW-rotation right-hand normal in metres (interior side for CW loop).
  const nx = ty / len * SHIFT_M;
  const ny = -tx / len * SHIFT_M;
  return [
    cur[0] + nx / (cosLat * 111000),
    cur[1] + ny / 111000,
  ];
});

// --- Step 3: for each waypoint, find nearest contour point ---
function dist(a, b) {
  // Approximate planar distance (scale lon by cos(lat) to make degrees comparable).
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
console.log("Waypoint anchors (contour idx, approx pre-correction distance in m):");
for (const a of wpAnchors) {
  console.log(`  ${a.label.padEnd(18)} idx=${a.contourIdx}, dist≈${(a.distDeg * 111000).toFixed(0)} m`);
}

// --- Step 4: order waypoints along the contour ---
// Contour was traced clockwise from topmost-leftmost. Route also goes CW.
// Sort anchors by contourIdx; if route direction is reverse, reverse waypoint order to match.
// We'll detect direction by checking whether the natural waypoint sequence
// matches sorted-by-contourIdx order.
const sortedByIdx = wpAnchors.slice().sort((a, b) => a.contourIdx - b.contourIdx);
console.log("Anchors in contour order:", sortedByIdx.map((a) => a.label));

// --- Step 5: piecewise drift correction ---
// For each contour point at index i, find which (anchor_a, anchor_b) pair it
// lies between (in route order along the contour). Compute drift at each
// anchor (true waypoint lat/lon - projected[contourIdx]). Lerp drift along
// the segment and add to projected[i].
//
// Treat contour as cyclic: pad the anchor list with the first anchor + N at
// the end so we can index past the wrap.
const N = projected.length;
const cycleAnchors = sortedByIdx.map((a) => ({
  ...a,
  drift: [a.lon - projected[a.contourIdx][0], a.lat - projected[a.contourIdx][1]],
}));
const wrappedAnchors = cycleAnchors.concat(
  cycleAnchors.map((a) => ({ ...a, contourIdx: a.contourIdx + N }))
);

const corrected = new Array(N);
let aIdx = 0; // pointer into wrappedAnchors
for (let i = 0; i < N; i++) {
  // Advance aIdx so that wrappedAnchors[aIdx].contourIdx <= i < wrappedAnchors[aIdx+1].contourIdx
  while (
    aIdx + 1 < wrappedAnchors.length &&
    wrappedAnchors[aIdx + 1].contourIdx <= i
  ) aIdx++;
  const A = wrappedAnchors[aIdx];
  const B = wrappedAnchors[aIdx + 1] ?? A;
  let t = 0;
  if (B.contourIdx > A.contourIdx) {
    t = (i - A.contourIdx) / (B.contourIdx - A.contourIdx);
  }
  const driftLon = A.drift[0] + t * (B.drift[0] - A.drift[0]);
  const driftLat = A.drift[1] + t * (B.drift[1] - A.drift[1]);
  corrected[i] = [
    projected[i][0] + driftLon,
    projected[i][1] + driftLat,
  ];
}

// Pin: explicitly set each anchor's position to exact waypoint lat/lon.
for (const a of cycleAnchors) {
  corrected[a.contourIdx] = [a.lon, a.lat];
}

// --- Step 6: constrained Laplacian smoothing ---
// Keep anchor points fixed at their exact waypoint locations, iteratively
// replace each non-anchor point with the midpoint of its neighbours. This
// minimises curvature without creating spikes at re-pinned anchors.
const anchorSet = new Set(cycleAnchors.map((a) => a.contourIdx));
let smoothed = corrected.map((p) => p.slice());
const ITERS = 2;
for (let it = 0; it < ITERS; it++) {
  const next = smoothed.map((p) => p.slice());
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue;
    const prev = smoothed[(i - 1 + N) % N];
    const nx = smoothed[(i + 1) % N];
    next[i] = [(prev[0] + nx[0]) * 0.5, (prev[1] + nx[1]) * 0.5];
  }
  smoothed = next;
}
// Anchors are still at their pinned positions because they were never updated.

// Close the ring.
smoothed.push(smoothed[0]);

const geojson = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "LineString", coordinates: smoothed },
    properties: {
      source: "Ten Tors 2026 Route E PDF (pixel trace, anchored to waypoints)",
      anchors: cycleAnchors.length,
    },
  }],
};
await fs.writeFile("route.geojson", JSON.stringify(geojson));
console.log(`Wrote route.geojson with ${smoothed.length} points (anchored to ${cycleAnchors.length} waypoints).`);

// Also write image bounds (corner lat/lons) so the verify page can overlay
// the OS map raster on the Leaflet map.
const corners = {
  topLeft:     pxToLatLon(0,            0),
  topRight:    pxToLatLon(route.width,  0),
  bottomLeft:  pxToLatLon(0,            route.height),
  bottomRight: pxToLatLon(route.width,  route.height),
};
// Leaflet ImageOverlay needs an axis-aligned [southwest, northeast] in lat/lon.
// OSGB→WGS84 introduces a tiny rotation but at this scale the error is sub-100 m.
const south = Math.min(corners.bottomLeft[1], corners.bottomRight[1]);
const north = Math.max(corners.topLeft[1],    corners.topRight[1]);
const west  = Math.min(corners.topLeft[0],    corners.bottomLeft[0]);
const east  = Math.max(corners.topRight[0],   corners.bottomRight[0]);
await fs.writeFile("image-bounds.json", JSON.stringify({
  imagePath: "img_p0_1.png",
  width: route.width,
  height: route.height,
  bounds: [[south, west], [north, east]],
  corners,
}, null, 2));
console.log("Wrote image-bounds.json");
