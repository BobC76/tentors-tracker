// Fetch Ten Tors route waypoints from tentors.org.uk and write routes.json.
//
// Usage:  node scripts/fetch-waypoints.mjs [--base-url https://www.tentors.org.uk]
//
// Fetches:
//   /admin/routes/tors-tt   → table of control tors: Name | Abbrev | Grid Ref
//   /admin/routes/tt35      → 35-mile routes (h2 "Route X" + table.table-route)
//   /admin/routes/tt45      → 45-mile routes
//   /admin/routes/tt55      → 55-mile routes
//
// Each table-route row has class="waypoint-main" or "waypoint-via"; names like
// "COSDON HILL [SC]" are stripped to "COSDON HILL" for lookup.
// OKE CAMP rows (start/finish) are replaced with fixed Okehampton camp coords.
//
// Outputs routes.json in the project root.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith("--base-url="))?.split("=")[1]
  ?? args[args.indexOf("--base-url") + 1]
  ?? "https://www.tentors.org.uk").replace(/\/$/, "");

// OSGB36 National Grid → WGS84
const OSGB36 = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs";
const WGS84  = "+proj=longlat +datum=WGS84 +no_defs";

// Okehampton camp (start/finish for all routes).
const OKE_CAMP = { lat: 50.71735, lon: -4.00209 };

// Convert an OS grid reference string (e.g. "SX 6361 9151") to {lat, lon}.
function gridRefToLatLon(gridRef) {
  const clean = gridRef.replace(/\s+/g, "").toUpperCase();
  if (clean.length < 6 || !/^[A-Z]{2}\d+$/.test(clean)) {
    throw new Error(`Unrecognised grid ref format: ${gridRef}`);
  }
  const l1 = clean[0], l2 = clean[1], nums = clean.slice(2);
  if (nums.length % 2 !== 0) throw new Error(`Odd digit count in grid ref: ${gridRef}`);
  const half = nums.length / 2;
  const scale = Math.pow(10, 5 - half);
  const subE = parseInt(nums.slice(0, half), 10) * scale;
  const subN = parseInt(nums.slice(half), 10) * scale;

  function letterVal(c) {
    let v = c.charCodeAt(0) - 65; // A=0
    if (v >= 8) v--;               // skip I
    return v;
  }
  function majorOffset(c) {
    const v = letterVal(c), col = v % 5, nf = 4 - Math.floor(v / 5);
    return { e: col * 500000 - 1000000, n: nf * 500000 - 500000 };
  }
  function subOffset(c) {
    const v = letterVal(c), col = v % 5, nf = 4 - Math.floor(v / 5);
    return { e: col * 100000, n: nf * 100000 };
  }

  const maj = majorOffset(l1), sub = subOffset(l2);
  const [lon, lat] = proj4(OSGB36, WGS84, [maj.e + sub.e + subE, maj.n + sub.n + subN]);
  return { lat, lon };
}

async function fetchPage(url) {
  console.log(`  GET ${url}`);
  const r = await fetch(url, { headers: { "User-Agent": "tentors-tracker/0.1" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#039;/g, "'").trim();
}

function extractCells(rowHtml) {
  const cells = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) cells.push(stripHtml(m[1]));
  return cells;
}

// Parse tors-tt: returns two maps:
//   byName[NORMALIZED_FULL_NAME] = {label, lat, lon}
//   byAbbrev[ABBREV] = {label, lat, lon}
function parseTors(html) {
  const byName = {}, byAbbrev = {};
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const cells = extractCells(m[1]);
    if (cells.length < 3) continue;
    const [name, abbrev, gridRef] = cells.map((c) => c.trim());
    if (!abbrev || !gridRef || !/^[A-Z]{2}\s+\d+\s+\d+$/i.test(gridRef)) continue;
    try {
      const coords = gridRefToLatLon(gridRef);
      const entry = { label: name.toUpperCase(), ...coords };
      byName[name.toUpperCase()] = entry;
      byAbbrev[abbrev.toUpperCase()] = entry;
    } catch (e) {
      console.warn(`  Could not convert grid ref for ${name}: ${e.message}`);
    }
  }
  return { byName, byAbbrev };
}

// Strip control-type suffixes from waypoint names.
// "COSDON HILL [SC]" → "COSDON HILL", "OKE TOR [SC*]" → "OKE TOR"
function stripSuffix(name) {
  return name.replace(/\s*\[(SC\*?|BC)\]$/i, "").trim().toUpperCase();
}

// Parse a route admin page (tt35/tt45/tt55).
// Finds <h2>Route X</h2> headers, then <table class="table-route"> that follows.
// Returns { letterToWaypoints } where each waypoint is { rawName, via }.
function parseRouteTables(html) {
  const result = {};

  // Split HTML on <h2> tags to find "Route X" sections.
  // We'll walk the HTML linearly using regex.
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let h2Match;
  let sections = []; // { letter, startIdx }

  while ((h2Match = h2Re.exec(html)) !== null) {
    const text = stripHtml(h2Match[1]);
    const lm = text.match(/^Route\s+([A-Z])$/i);
    if (lm) {
      sections.push({ letter: lm[1].toUpperCase(), startIdx: h2Match.index + h2Match[0].length });
    }
  }

  for (let i = 0; i < sections.length; i++) {
    const { letter, startIdx } = sections[i];
    const endIdx = i + 1 < sections.length ? sections[i + 1].startIdx : html.length;
    const chunk = html.slice(startIdx, endIdx);

    // Find <table class="table-route"> within this chunk.
    const tableMatch = chunk.match(/<table\s+class="table-route">([\s\S]*?)<\/table>/i);
    if (!tableMatch) { console.warn(`  No table-route found for Route ${letter}`); continue; }
    const tableHtml = tableMatch[1];

    const waypoints = [];
    const rowRe = /<tr\s+class="(waypoint-main|waypoint-via)"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const cls = rowMatch[1];
      const cells = extractCells(rowMatch[2]);
      if (cells.length < 2) continue;
      const rawName = cells[1].trim(); // second cell is the name
      if (!rawName || rawName.toUpperCase() === "OKE CAMP") continue; // skip start/finish
      waypoints.push({ rawName, via: cls === "waypoint-via" });
    }

    result[letter] = waypoints;
  }

  return result;
}

async function main() {
  console.log(`\nFetching from ${baseUrl}\n`);

  // 1. Fetch and parse control tors
  console.log("1. Fetching control tors...");
  const torsHtml = await fetchPage(`${baseUrl}/admin/routes/tors-tt`);
  const { byName } = parseTors(torsHtml);
  console.log(`   Found ${Object.keys(byName).length} tors: ${Object.keys(byName).slice(0, 10).join(", ")}...`);

  if (Object.keys(byName).length === 0) {
    console.error("  No tors parsed — check HTML format. Exiting.");
    process.exit(1);
  }

  // 2. Fetch route tables
  const allRoutes = {};
  for (const page of ["tt35", "tt45", "tt55"]) {
    console.log(`\n2. Fetching /admin/routes/${page}...`);
    const html = await fetchPage(`${baseUrl}/admin/routes/${page}`);
    const routes = parseRouteTables(html);
    const letters = Object.keys(routes).sort();
    console.log(`   Found ${letters.length} routes: ${letters.join(", ")}`);
    for (const [letter, wps] of Object.entries(routes)) {
      if (allRoutes[letter]) {
        console.warn(`   Duplicate route ${letter} in ${page} (keeping first)`);
      } else {
        allRoutes[letter] = wps;
      }
    }
  }

  if (Object.keys(allRoutes).length === 0) {
    console.error("  No routes parsed — check HTML format. Exiting.");
    process.exit(1);
  }

  // 3. Build routes.json
  const output = {};
  const missingTors = [];

  for (const letter of Object.keys(allRoutes).sort()) {
    const rawWaypoints = allRoutes[letter];
    const waypoints = [
      { label: "START", ...OKE_CAMP, via: false, nt: null },
    ];

    for (const { rawName, via } of rawWaypoints) {
      const key = stripSuffix(rawName);
      const tor = byName[key];
      if (!tor) {
        console.warn(`  [Route ${letter}] Unknown tor: "${rawName}" (normalised: "${key}")`);
        missingTors.push(`${key} (Route ${letter})`);
        waypoints.push({ label: key, lat: null, lon: null, via, nt: null });
      } else {
        waypoints.push({ label: tor.label, lat: tor.lat, lon: tor.lon, via, nt: null });
      }
    }

    waypoints.push({ label: "FINISH", ...OKE_CAMP, via: false, nt: null });
    output[letter] = { waypoints };
  }

  // 4. Preserve any manually-entered routes not in the fetched set
  const routesPath = path.join(ROOT, "routes.json");
  try {
    const existing = JSON.parse(await fs.readFile(routesPath, "utf8"));
    for (const [letter, data] of Object.entries(existing)) {
      if (!output[letter]) {
        console.log(`  Preserving manual route ${letter} from existing routes.json`);
        output[letter] = data;
      }
    }
  } catch { /* no existing file */ }

  await fs.writeFile(routesPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote routes.json — ${Object.keys(output).length} routes: ${Object.keys(output).sort().join(", ")}`);

  if (missingTors.length > 0) {
    console.warn(`\nWarning: ${missingTors.length} unresolved tor name(s):`);
    for (const m of [...new Set(missingTors)].sort()) console.warn(`  - ${m}`);
    console.warn("Add them to the tors-tt admin table, or fix the name mapping in this script.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
