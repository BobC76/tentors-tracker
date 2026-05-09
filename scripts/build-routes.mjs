// Build routes.json from the live tentors.org.uk route pages.
// For each route letter (a..j) it pulls the waypoint sequence from the
// page's column headers and joins it with the master grid-ref catalogue.

import fs from "node:fs/promises";
import path from "node:path";
import proj4 from "proj4";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

// Master grid refs from https://tentors.org.uk/admin/routes/tors-tt
const GRID_REFS = {
  "COSDON HILL":      "SX 6361 9151",
  "DINGER TOR":       "SX 5864 8809",
  "EAST MILL TOR":    "SX 5994 8987",
  "FERNWORTHY":       "SX 6407 8432",
  "GREAT KNEESET":    "SX 5890 8587",
  "HARE TOR":         "SX 5512 8428",
  "HIGHER TOR":       "SX 6127 9173",
  "HIGHER WHITE TOR": "SX 6180 7860",
  "HOLMING BEAM":     "SX 5914 7646",
  "KES TOR":          "SX 6654 8627",
  "KITTY TOR":        "SX 5673 8744",
  "LITTLE MIS TOR":   "SX 5646 7632",
  "NODDEN GATE":      "SX 5300 8632",
  "OKE CAMP":         "SX 5878 9262",
  "OKE TOR":          "SX 6131 8978",
  "OKEMENT HILL":     "SX 6026 8775",
  "POSTBRIDGE":       "SX 6460 7879",
  "PREWLEY MOOR":     "SX 5469 9095",
  "ROUGH TOR":        "SX 6060 7983",
  "SHILSTONE TOR":    "SX 6580 9020",
  "SITTAFORD TOR":    "SX 6335 8305",
  "STANDON FARM":     "SX 5450 8146",
  "STANNON TOR":      "SX 6469 8109",
  "STEEPERTON TOR":   "SX 6184 8889",
  "WATER HILL":       "SX 6714 8128",
  "WATERN TOR":       "SX 6290 8690",
  "WHITE BARROW":     "SX 5685 7931",
  "WHITE TOR":        "SX 5445 7868",
  "WILLSWORTHY":      "SX 5257 8327",
};

// NT cut-offs we know (Route E only — extracted from the tt35 admin page).
// Other routes/distances can be added here later.
const NTS_BY_ROUTE = {
  E: {
    "WATER HILL":       "18:00",
    "POSTBRIDGE":       "18:20",
    "HIGHER WHITE TOR": "18:20",
    "HOLMING BEAM":     "18:10",
    "WHITE BARROW":     "18:30",
    "STANDON FARM":     "17:50",
  },
};

function toLatLon(gridRef) {
  const m = gridRef.replace(/\s+/g, "").match(/^SX(\d+)$/);
  if (!m) throw new Error("bad grid ref: " + gridRef);
  const d = m[1]; const half = d.length / 2;
  const e = parseInt(d.slice(0, half).padEnd(5, "0"), 10);
  const n = parseInt(d.slice(half).padEnd(5, "0"), 10);
  const easting = 200000 + e, northing = 0 + n;
  const [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [easting, northing]);
  return { lat, lon };
}

async function fetchHeaders(letter) {
  const url = `https://tentors.org.uk/eventdata/route${letter}.html`;
  const html = await (await fetch(url)).text();
  // Extract the first run of <div>NAME</div> entries — those are the column
  // headers. Skip CODE; also collect TEAM if present (it's in a wrapped div).
  const out = [];
  for (const m of html.matchAll(/<div>([A-Z][A-Z0-9 \(\)]+)<\/div>/g)) {
    const t = m[1].trim();
    if (t === "CODE" || t === "TEAM") continue;
    out.push(t);
  }
  return out;
}

const out = {};
for (const letter of "abcdefghij") {
  const names = await fetchHeaders(letter);
  if (!names.length) { console.warn(`route ${letter}: no headers found`); continue; }
  const waypoints = names.map((n) => {
    const via = / \(via\)$/i.test(n);
    const clean = n.replace(/\s*\(via\)\s*$/i, "").trim();
    const lookupName = (clean === "START" || clean === "FINISH") ? "OKE CAMP" : clean;
    const gr = GRID_REFS[lookupName];
    if (!gr) {
      console.warn(`route ${letter}: missing grid for "${clean}"`);
      return { label: clean, lat: null, lon: null, via, nt: null };
    }
    const { lat, lon } = toLatLon(gr);
    const nt = NTS_BY_ROUTE[letter.toUpperCase()]?.[clean] || null;
    return { label: clean, lat, lon, via, nt };
  });
  out[letter.toUpperCase()] = { waypoints };
  console.log(`route ${letter.toUpperCase()}: ${waypoints.length} waypoints`);
}

await fs.writeFile(path.join(process.cwd(), "routes.json"), JSON.stringify(out, null, 2));
console.log(`Wrote routes.json (${Object.keys(out).length} routes)`);
