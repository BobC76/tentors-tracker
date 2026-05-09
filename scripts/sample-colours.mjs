// Sample pixel colours along expected route locations and along roads
// (top-left of map). Route should be darker/more saturated than roads.

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const IMG = path.join(process.cwd(), "img_p0_1.png");
const { data: pixels, info } = await sharp(IMG).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;

function rgbAt(x, y) {
  const i = (y * W + x) * 3;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

// Find all "reddish" pixels in two regions and compute their colour histograms.
function histRegion(x0, y0, x1, y1, label) {
  const reds = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = rgbAt(x, y);
      if (r > 100 && r - g > 30 && r - b > 30) reds.push([r, g, b]);
    }
  }
  if (!reds.length) {
    console.log(`${label}: no red pixels`);
    return;
  }
  const avg = reds.reduce((a, [r, g, b]) => [a[0] + r, a[1] + g, a[2] + b], [0, 0, 0])
    .map((v) => Math.round(v / reds.length));
  // Take the darkest 5% (most saturated reds)
  reds.sort((a, b) => (a[0] - a[1]) - (b[0] - b[1])); // sort by brightness-ish
  // R-G distribution
  const rgDiffs = reds.map(([r, g]) => r - g).sort((a, b) => a - b);
  const median = rgDiffs[rgDiffs.length >> 1];
  const p10 = rgDiffs[(rgDiffs.length * 0.1) | 0];
  const p90 = rgDiffs[(rgDiffs.length * 0.9) | 0];
  console.log(`${label} (${reds.length} red px): avg=${avg.join(",")}, R-G median=${median} (p10=${p10}, p90=${p90})`);
}

// Top-left of map ~ road network area
console.log("Sampling regions...");
histRegion(0, 0, 800, 800, "top-left (roads)");
// Centre of map ~ should mostly be the route
histRegion(1000, 1500, 2300, 3500, "centre  (route )");
// Edges below that ~ more route
histRegion(0, 1500, 800, 3500, "left    (mixed)");

// Dump the brightest and darkest red pixels in each region.
function brightnessSample(x0, y0, x1, y1, label) {
  let darkestR = 999;
  let brightestR = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = rgbAt(x, y);
      if (r > 100 && r - g > 80 && r - b > 50) {
        if (r < darkestR) darkestR = r;
        if (r > brightestR) brightestR = r;
      }
    }
  }
  console.log(`${label}: highly-saturated red pixels — darkest R=${darkestR}, brightest R=${brightestR}`);
}
brightnessSample(0, 0, 800, 800, "top-left");
brightnessSample(1000, 1500, 2300, 3500, "centre  ");
