// Trace the red route line on the OS map raster.
//
// Pipeline:
//   1. Tight saturated-maroon mask.
//   2. Dilate (radius 16) to bridge waypoint-marker gaps.
//   3. Connected components → pick the component with largest bounding box
//      (= the route loop).
//   4. Erode by 12 px to shrink towards centerline.
//   5. Moore-neighbour boundary trace → ordered closed polygon.
//   6. Take only the OUTER contour (start at topmost-leftmost pixel).
//   7. Decimate via Ramer-Douglas-Peucker.
//   8. Save route-pixels.json.

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const IMG = path.join(process.cwd(), "img_p0_1.png");
const { data: pixels, info } = await sharp(IMG).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
console.log(`Image: ${W}×${H}`);

const mask = (() => {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (r >= 110 && r <= 210 && g <= 60 && r - g >= 90 && r - b >= 30) m[y * W + x] = 1;
  }
  return m;
})();

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

function erode(src, radius) {
  let cur = src;
  for (let r = 0; r < radius; r++) {
    const a = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = cur[i];
      if (v && (x === 0 || !cur[i - 1])) v = 0;
      if (v && (x === W - 1 || !cur[i + 1])) v = 0;
      a[i] = v;
    }
    const b = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = a[i];
      if (v && (y === 0 || !a[i - W])) v = 0;
      if (v && (y === H - 1 || !a[i + W])) v = 0;
      b[i] = v;
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

async function savePng(mask, name) {
  const buf = Buffer.alloc(W * H);
  for (let i = 0; i < mask.length; i++) buf[i] = mask[i] ? 255 : 0;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(process.cwd(), name));
  console.log(`  → ${name}`);
}

console.log("Step 1: red mask");
console.log(`  ${mask.reduce((a, v) => a + v, 0)} px`);

console.log("Step 2: dilate 16");
const dilated = dilate(mask, 16);

console.log("Step 3: components");
const cc = components(dilated);
let bestLbl = 0, bestArea = 0;
for (let lbl = 1; lbl < cc.sizes.length; lbl++) {
  const bb = cc.bbox[lbl];
  const area = (bb.x1 - bb.x0) * (bb.y1 - bb.y0);
  if (area > bestArea) { bestArea = area; bestLbl = lbl; }
}
const routeMask = new Uint8Array(W * H);
for (let i = 0; i < cc.labels.length; i++) if (cc.labels[i] === bestLbl) routeMask[i] = 1;
console.log(`  picked label ${bestLbl}: ${cc.sizes[bestLbl]} px, bbox area ${bestArea}`);

console.log("Step 4: Moore-neighbour outer contour trace");
function trace(mask) {
  // Find start: topmost-leftmost foreground pixel.
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y * W + x]) { sx = x; sy = y; break outer; }
  }
  if (sx < 0) return [];
  console.log(`  start: (${sx}, ${sy})`);

  // 8 directions clockwise from East:
  // 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
  const D = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];

  let cx = sx, cy = sy;
  // Backtrack = direction we came from. For topmost-leftmost, came from W.
  let backtrack = 4;
  const path = [[cx, cy]];

  for (let safety = 0; safety < W * H * 2; safety++) {
    // Search clockwise starting just past backtrack.
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (backtrack + k) % 8;
      const [dx, dy] = D[d];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!mask[ny * W + nx]) continue;
      cx = nx; cy = ny;
      path.push([cx, cy]);
      backtrack = (d + 4) % 8;
      found = true;
      break;
    }
    if (!found) break;
    // Stop when we return to start with a few steps taken.
    if (path.length > 3 && cx === sx && cy === sy) break;
  }
  return path;
}

const contour = trace(routeMask);
console.log(`  traced ${contour.length} pixels`);

// Save debug overlay: draw contour on original image.
{
  const dbg = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    dbg[i * 3] = pixels[i * 3]; dbg[i * 3 + 1] = pixels[i * 3 + 1]; dbg[i * 3 + 2] = pixels[i * 3 + 2];
  }
  for (const [x, y] of contour) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = (py * W + px) * 3;
      dbg[i] = 0; dbg[i + 1] = 200; dbg[i + 2] = 0;
    }
  }
  await sharp(dbg, { raw: { width: W, height: H, channels: 3 } }).png().toFile(path.join(process.cwd(), "debug-contour.png"));
  console.log("  → debug-contour.png");
}

// --- Decimate via RDP ---
function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  function perpDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    const tx = a[0] + t * dx, ty = a[1] + t * dy;
    return Math.hypot(p[0] - tx, p[1] - ty);
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
    if (maxD > eps && maxK > 0) {
      keep[maxK] = 1;
      stack.push([i0, maxK]);
      stack.push([maxK, i1]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
const decimated = rdp(contour, 4);
console.log(`Decimated contour: ${decimated.length} points (from ${contour.length})`);

await fs.writeFile(
  path.join(process.cwd(), "route-pixels.json"),
  JSON.stringify({ width: W, height: H, points: decimated }, null, 2)
);
console.log("→ route-pixels.json");
