// Build waypoints.json from authoritative OS grid refs (tentors.org.uk admin list).
// Converts OSGB36 grid → WGS84 lat/lon via proj4.

import fs from "node:fs/promises";
import path from "node:path";
import proj4 from "proj4";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

// Route E waypoints in order. Grid refs from tentors.org.uk admin (10m precision).
// "via" = pass-through (not a staffed checkpoint).
const ROUTE = [
  { label: "START",            fixed: { lat: 50.71680569, lon: -4.00212532 } },
  { label: "OKE TOR",          gr: "SX 6131 8978", via: true },
  { label: "OKEMENT HILL",     gr: "SX 6026 8775" },
  { label: "WATERN TOR",       gr: "SX 6290 8690" },
  { label: "FERNWORTHY",       gr: "SX 6407 8432" },
  { label: "SITTAFORD TOR",    gr: "SX 6335 8305", via: true },
  { label: "WATER HILL",       gr: "SX 6714 8128" },
  { label: "POSTBRIDGE",       gr: "SX 6460 7879", via: true },
  { label: "HIGHER WHITE TOR", gr: "SX 6180 7860" },
  { label: "HOLMING BEAM",     gr: "SX 5914 7646" },
  { label: "WHITE BARROW",     gr: "SX 5685 7931", via: true },
  { label: "STANDON FARM",     gr: "SX 5450 8146" },
  { label: "HARE TOR",         gr: "SX 5512 8428" },
  { label: "NODDEN GATE",      gr: "SX 5300 8632" },
  { label: "KITTY TOR",        gr: "SX 5673 8744", via: true },
  { label: "EAST MILL TOR",    gr: "SX 5994 8987" },
  { label: "FINISH",           fixed: { lat: 50.71788492, lon: -4.00205018 } },
];

// Two-letter 100km grid origins (easting, northing in metres).
// Only including those we need; SX covers all of Dartmoor.
const PREFIX = {
  SX: [200000,      0],
};

function parseGridRef(gr) {
  const m = gr.replace(/\s+/g, "").toUpperCase().match(/^([A-Z]{2})(\d+)$/);
  if (!m) throw new Error("bad grid ref: " + gr);
  const [, letters, digits] = m;
  if (digits.length % 2) throw new Error("odd digit count: " + gr);
  const half = digits.length / 2;
  const eDigits = digits.slice(0, half);
  const nDigits = digits.slice(half);
  // Pad to 5 digits (1m precision) by appending zeros.
  const e = parseInt(eDigits.padEnd(5, "0"), 10);
  const n = parseInt(nDigits.padEnd(5, "0"), 10);
  const origin = PREFIX[letters];
  if (!origin) throw new Error("unknown grid square: " + letters);
  return { easting: origin[0] + e, northing: origin[1] + n };
}

function toLatLon(gr) {
  const { easting, northing } = parseGridRef(gr);
  const [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [easting, northing]);
  return { lat, lon };
}

const out = ROUTE.map((wp) => {
  if (wp.fixed) {
    return { label: wp.label, lat: wp.fixed.lat, lon: wp.fixed.lon, via: !!wp.via, source: "user" };
  }
  const { lat, lon } = toLatLon(wp.gr);
  return { label: wp.label, lat, lon, via: !!wp.via, source: "tentors.org.uk", grid_ref: wp.gr };
});

await fs.writeFile(path.join(process.cwd(), "waypoints.json"), JSON.stringify(out, null, 2));
console.log("Route E waypoints (lat, lon):");
for (const w of out) {
  console.log(`  ${String(out.indexOf(w) + 1).padStart(2)}. ${w.label.padEnd(18)} ${w.lat.toFixed(6)}, ${w.lon.toFixed(6)}${w.via ? "  (via)" : ""}`);
}
