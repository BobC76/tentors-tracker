// Fetch Ten Tors route waypoints from tentors.org.uk and write routes.json.
//
// Usage:  node scripts/fetch-waypoints.mjs [--base-url https://www.tentors.org.uk]
//
// Fetches:
//   /admin/routes/tors-tt   → table of all control tors with OS grid refs
//   /admin/routes/tt35      → 35-mile route sequences (letters A–Z)
//   /admin/routes/tt45      → 45-mile route sequences
//   /admin/routes/tt55      → 55-mile route sequences
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

// Convert an OS grid reference string (e.g. "SX 6361 9151") to {lat, lon}.
function gridRefToLatLon(gridRef) {
  const clean = gridRef.replace(/\s+/g, "").toUpperCase();
  if (clean.length < 4) throw new Error(`Grid ref too short: ${gridRef}`);

  const l1 = clean[0];
  const l2 = clean[1];
  const nums = clean.slice(2);
  if (nums.length % 2 !== 0) throw new Error(`Odd digit count in grid ref: ${gridRef}`);
  const half = nums.length / 2;
  const rawE = parseInt(nums.slice(0, half), 10);
  const rawN = parseInt(nums.slice(half), 10);
  // Scale to metres (e.g. 4 digits → 10 m precision)
  const scale = Math.pow(10, 5 - half);
  const subE = rawE * scale;
  const subN = rawN * scale;

  // Convert a letter to 0-24 (skipping I=8)
  function letterVal(c) {
    let v = c.charCodeAt(0) - 65; // A=0
    if (v >= 8) v--; // skip I
    return v;
  }

  // Calculate 500km major square offset (with the grid's internal offset of -1000000, -500000)
  function majorOffset(c) {
    const v = letterVal(c);
    const col = v % 5;
    const rowFromNorth = Math.floor(v / 5);
    const northFactor = 4 - rowFromNorth; // 0=south, 4=north
    return {
      e: col * 500000 - 1000000,
      n: northFactor * 500000 - 500000,
    };
  }

  // Calculate 100km sub-square offset within the major square
  function subOffset(c) {
    const v = letterVal(c);
    const col = v % 5;
    const rowFromNorth = Math.floor(v / 5);
    const northFactor = 4 - rowFromNorth;
    return {
      e: col * 100000,
      n: northFactor * 100000,
    };
  }

  const maj = majorOffset(l1);
  const sub = subOffset(l2);

  const easting  = maj.e + sub.e + subE;
  const northing = maj.n + sub.n + subN;

  const [lon, lat] = proj4(OSGB36, WGS84, [easting, northing]);
  return { lat, lon };
}

async function fetchPage(url) {
  console.log(`  GET ${url}`);
  const r = await fetch(url, {
    headers: { "User-Agent": "tentors-tracker/0.1" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// Parse the tors-tt admin page to build a map of TOR_ABBREV → {label, lat, lon}.
// The table has columns: Tor Name | Abbrev. | Grid Ref.
function parseTors(html) {
  const tors = {};
  // Match rows in a table: each <tr> with at least 3 <td> cells.
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length < 3) continue;
    const [name, abbrev, gridRef] = cells;
    if (!abbrev || !gridRef || !/^[A-Z]{2}\s+\d+\s+\d+$/i.test(gridRef.trim())) continue;
    try {
      const coords = gridRefToLatLon(gridRef.trim());
      tors[abbrev.toUpperCase()] = { label: name.toUpperCase(), ...coords };
    } catch (e) {
      console.warn(`  Could not convert grid ref for ${name} (${abbrev}): ${e.message}`);
    }
  }
  return tors;
}

// Parse a route admin page (tt35/tt45/tt55) to build a map of routeLetter → [abbrev, ...].
// Expected structure: route letter headings with ordered lists of waypoints.
// The page structure seems to be sections per route letter.
function parseRouteSequences(html) {
  const routes = {};
  // Look for patterns like "Route A:" or "A:" followed by comma/list of abbreviated tor names
  // The exact format is unknown; we try to handle common patterns.

  // Strategy 1: look for table rows with a route letter and a sequence
  // Strategy 2: look for headings (h2/h3/h4) with a letter, then lists

  // Try to find <tr> rows where first cell is a single letter and second is a sequence
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length < 2) continue;
    const letter = cells[0].toUpperCase().replace(/^ROUTE\s*/, "").trim();
    if (!/^[A-Z]$/.test(letter)) continue;
    // Second cell: comma or space separated list of abbreviations
    const seq = cells[1]
      .split(/[\s,→\-]+/)
      .map((s) => s.toUpperCase().trim())
      .filter((s) => s.length > 0);
    if (seq.length > 0) {
      routes[letter] = seq;
    }
  }

  return routes;
}

// Build the routes.json structure from tor coords and route sequences.
// Standard waypoint entry: { label, lat, lon, via: false, nt: null }
// The start/finish is at Okehampton camp; we'll use a known fixed coord.
const OKEHAMPTON_CAMP = { lat: 50.71735, lon: -4.00209 };

function buildRouteWaypoints(letter, sequence, tors) {
  const waypoints = [
    { label: "START", ...OKEHAMPTON_CAMP, via: false, nt: null },
  ];

  for (const abbrev of sequence) {
    const tor = tors[abbrev];
    if (!tor) {
      console.warn(`  [Route ${letter}] Unknown tor abbreviation: ${abbrev}`);
      waypoints.push({ label: abbrev, lat: null, lon: null, via: false, nt: null });
    } else {
      waypoints.push({ label: tor.label, lat: tor.lat, lon: tor.lon, via: false, nt: abbrev });
    }
  }

  waypoints.push({ label: "FINISH", ...OKEHAMPTON_CAMP, via: false, nt: null });
  return waypoints;
}

async function main() {
  console.log(`\nFetching from ${baseUrl}\n`);

  // 1. Fetch and parse tors
  console.log("1. Fetching control tors...");
  const torsHtml = await fetchPage(`${baseUrl}/admin/routes/tors-tt`);
  const tors = parseTors(torsHtml);
  console.log(`   Found ${Object.keys(tors).length} tors: ${Object.keys(tors).join(", ")}`);

  if (Object.keys(tors).length === 0) {
    console.error("  No tors parsed - check HTML format. Exiting.");
    process.exit(1);
  }

  // 2. Fetch and parse route sequences
  const routePages = ["tt35", "tt45", "tt55"];
  const allRoutes = {};

  for (const page of routePages) {
    console.log(`\n2. Fetching routes from /admin/routes/${page}...`);
    const html = await fetchPage(`${baseUrl}/admin/routes/${page}`);
    const sequences = parseRouteSequences(html);
    console.log(`   Found ${Object.keys(sequences).length} routes: ${Object.keys(sequences).join(", ")}`);
    for (const [letter, seq] of Object.entries(sequences)) {
      if (allRoutes[letter]) {
        console.warn(`   Duplicate route ${letter} in ${page} (keeping first)`);
      } else {
        allRoutes[letter] = seq;
      }
    }
  }

  if (Object.keys(allRoutes).length === 0) {
    console.error("  No routes parsed - check HTML format. Exiting.");
    process.exit(1);
  }

  // 3. Load existing routes.json to preserve any manual entries
  const routesPath = path.join(ROOT, "routes.json");
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(routesPath, "utf8"));
    console.log(`\n3. Loaded existing routes.json (${Object.keys(existing).length} routes)`);
  } catch {
    console.log("\n3. No existing routes.json - creating fresh");
  }

  // 4. Build updated routes.json
  const output = {};
  const sortedLetters = Object.keys(allRoutes).sort();
  for (const letter of sortedLetters) {
    const sequence = allRoutes[letter];
    const waypoints = buildRouteWaypoints(letter, sequence, tors);
    output[letter] = { waypoints };
  }

  // Preserve any routes that were in existing but not fetched (manual overrides)
  for (const [letter, data] of Object.entries(existing)) {
    if (!output[letter]) {
      console.log(`  Preserving manual route ${letter} from existing routes.json`);
      output[letter] = data;
    }
  }

  await fs.writeFile(routesPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote routes.json with ${Object.keys(output).length} routes: ${Object.keys(output).sort().join(", ")}`);

  // Report any missing tor lookups
  const missingTors = new Set();
  for (const [letter, seq] of Object.entries(allRoutes)) {
    for (const abbrev of seq) {
      if (!tors[abbrev]) missingTors.add(`${abbrev} (route ${letter})`);
    }
  }
  if (missingTors.size > 0) {
    console.warn(`\nWarning: ${missingTors.size} unresolved tor abbreviation(s):`);
    for (const m of [...missingTors].sort()) console.warn(`  - ${m}`);
    console.warn("Add the missing tors to the tors-tt admin table, or add them manually to routes.json.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
