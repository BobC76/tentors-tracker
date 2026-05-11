// Seed all data for a given Ten Tors year.
//
// Usage:  node scripts/seed.mjs <year> [--base-url https://www.tentors.org.uk]
//
// What it does:
//   1. Fetches /admin/routes/tors-tt  → control tor names + OS grid refs
//   2. Fetches /admin/routes/tt35|tt45|tt55 → route waypoint sequences
//      Converts OSGB36 grid refs to WGS84 via proj4 → writes routes.json
//   3. Fetches /page/results (or archive equivalent) → discovers route letters
//   4. Fetches /page/ten-tors-teams (or archive equivalent) → establishment list
//      Writes data/{year}/teams-raw.json  (all establishments + team counts)
//      Writes data/{year}/config.json     (route sections, preserving any
//                                          existing nt_overrides/corrections/teams)
//
// Note: /page/ten-tors-teams lists establishments but NOT which route each
// team is assigned to. After running this script:
//   - Check /page/route-allocations to find route letters per establishment
//   - Edit data/{year}/config.json to add teams to the correct route sections
//   - Set "distance" for each route (35, 45, or 55)
//   - Set "match" for each team (substring of the name in the eventdata table)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// --- Args ---
const args = process.argv.slice(2);
const year = args.find((a) => /^\d{4}$/.test(a));
if (!year) {
  console.error("Usage: node scripts/seed.mjs <year> [--base-url <url>]");
  process.exit(1);
}
const baseUrl = (args.find((a) => a.startsWith("--base-url="))?.split("=")[1]
  ?? args[args.indexOf("--base-url") + 1]
  ?? "https://www.tentors.org.uk").replace(/\/$/, "");

const currentYear = new Date().getFullYear().toString();
const isArchive = year !== currentYear;

// --- OSGB36 → WGS84 ---
const OSGB36 = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs";
const WGS84  = "+proj=longlat +datum=WGS84 +no_defs";

const OKE_CAMP = { lat: 50.71735, lon: -4.00209 };

function gridRefToLatLon(gridRef) {
  const clean = gridRef.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d+$/.test(clean) || clean.length < 6) throw new Error(`Bad grid ref: ${gridRef}`);
  const l1 = clean[0], l2 = clean[1], nums = clean.slice(2);
  if (nums.length % 2 !== 0) throw new Error(`Odd digits in grid ref: ${gridRef}`);
  const half = nums.length / 2;
  const scale = Math.pow(10, 5 - half);
  const subE = parseInt(nums.slice(0, half), 10) * scale;
  const subN = parseInt(nums.slice(half), 10) * scale;

  function lv(c) { let v = c.charCodeAt(0) - 65; if (v >= 8) v--; return v; }
  function maj(c) { const v = lv(c); return { e: (v%5)*500000-1000000, n: (4-Math.floor(v/5))*500000-500000 }; }
  function sub(c) { const v = lv(c); return { e: (v%5)*100000, n: (4-Math.floor(v/5))*100000 }; }

  const m = maj(l1), s = sub(l2);
  const [lon, lat] = proj4(OSGB36, WGS84, [m.e+s.e+subE, m.n+s.n+subN]);
  return { lat, lon };
}

// --- HTML helpers ---
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&#039;/g,"'").replace(/&nbsp;/g," ").trim();
}
function extractCells(html) {
  const cells = [], re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html)) !== null) cells.push(stripHtml(m[1]));
  return cells;
}

// --- Fetch ---
async function get(url) {
  console.log(`  GET ${url}`);
  const r = await fetch(url, { headers: { "User-Agent": "tentors-tracker/0.1" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function url(page) {
  // page is e.g. "admin/routes/tors-tt", "page/results", "page/ten-tors-teams"
  if (isArchive && page.startsWith("page/")) {
    return `${baseUrl}/archive/${year}/${page}.html`;
  }
  return `${baseUrl}/${page}`;
}

// ============================================================
// Step 1 & 2: tors + routes → routes.json
// ============================================================

function parseTors(html) {
  const byName = {};
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const cells = extractCells(m[1]);
    if (cells.length < 3) continue;
    const [name, , gridRef] = cells.map(c => c.trim());
    if (!gridRef || !/^[A-Z]{2}\s+\d+\s+\d+$/i.test(gridRef)) continue;
    try {
      byName[name.toUpperCase()] = { label: name.toUpperCase(), ...gridRefToLatLon(gridRef) };
    } catch (e) {
      console.warn(`    Could not convert grid ref for ${name}: ${e.message}`);
    }
  }
  return byName;
}

function stripSuffix(name) {
  return name.replace(/\s*\[(SC\*?|BC)\]$/i, "").trim().toUpperCase();
}

function parseRouteTables(html) {
  const result = {};
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const sections = [];
  let m;
  while ((m = h2Re.exec(html)) !== null) {
    const lm = stripHtml(m[1]).match(/^Route\s+([A-Z])$/i);
    if (lm) sections.push({ letter: lm[1].toUpperCase(), start: m.index + m[0].length });
  }
  for (let i = 0; i < sections.length; i++) {
    const { letter, start } = sections[i];
    const end = i + 1 < sections.length ? sections[i+1].start : html.length;
    const chunk = html.slice(start, end);
    const tableMatch = chunk.match(/<table\s+class="table-route">([\s\S]*?)<\/table>/i);
    if (!tableMatch) { console.warn(`    No table-route for Route ${letter}`); continue; }
    const rows = [], rowRe = /<tr\s+class="(waypoint-main|waypoint-via)"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tableMatch[1])) !== null) {
      const cells = extractCells(rm[2]);
      if (cells.length < 2) continue;
      const rawName = cells[1].trim();
      if (!rawName || rawName.toUpperCase() === "OKE CAMP") continue;
      rows.push({ rawName, via: rm[1] === "waypoint-via" });
    }
    result[letter] = rows;
  }
  return result;
}

async function seedRoutes(torsByName) {
  const allRoutes = {};
  for (const page of ["tt35", "tt45", "tt55"]) {
    console.log(`  Fetching /admin/routes/${page}...`);
    const html = await get(`${baseUrl}/admin/routes/${page}`);
    for (const [letter, rows] of Object.entries(parseRouteTables(html))) {
      if (!allRoutes[letter]) allRoutes[letter] = rows;
    }
  }
  console.log(`  Routes found: ${Object.keys(allRoutes).sort().join(", ")}`);

  // Build routes.json
  const output = {};
  const missing = [];
  for (const letter of Object.keys(allRoutes).sort()) {
    const waypoints = [{ label: "START", ...OKE_CAMP, via: false, nt: null }];
    for (const { rawName, via } of allRoutes[letter]) {
      const key = stripSuffix(rawName);
      const tor = torsByName[key];
      if (!tor) {
        console.warn(`    [Route ${letter}] Unknown tor: "${key}"`);
        missing.push(`${key} (Route ${letter})`);
        waypoints.push({ label: key, lat: null, lon: null, via, nt: null });
      } else {
        waypoints.push({ label: tor.label, lat: tor.lat, lon: tor.lon, via, nt: null });
      }
    }
    waypoints.push({ label: "FINISH", ...OKE_CAMP, via: false, nt: null });
    output[letter] = { waypoints };
  }

  // Preserve manually-entered routes not in the fetched set
  const routesPath = path.join(ROOT, "routes.json");
  try {
    const existing = JSON.parse(await fs.readFile(routesPath, "utf8"));
    for (const [l, d] of Object.entries(existing)) {
      if (!output[l]) { console.log(`  Preserving manual route ${l}`); output[l] = d; }
    }
  } catch { /* no existing file */ }

  await fs.writeFile(routesPath, JSON.stringify(output, null, 2));
  console.log(`  Wrote routes.json (${Object.keys(output).length} routes)`);

  if (missing.length) {
    const unique = [...new Set(missing)].sort();
    console.warn(`  Warning: ${unique.length} unresolved tor(s):`);
    unique.forEach(m => console.warn(`    - ${m}`));
  }
}

// ============================================================
// Step 3 & 4: results + teams → config.json + teams-raw.json
// ============================================================

function parseResultRoutes(html) {
  const letters = new Set();
  const re = /eventdata\/route([a-zA-Z])\.html/gi;
  let m;
  while ((m = re.exec(html)) !== null) letters.add(m[1].toUpperCase());
  return [...letters].sort();
}

function parseTeamsTable(html) {
  const establishments = [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) { console.warn("  No <tbody> in teams table"); return establishments; }
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tbodyMatch[1])) !== null) {
    const cells = extractCells(m[1]);
    if (cells.length < 9) continue;
    const code = cells[0].trim(), name = cells[1].trim();
    if (!name || !/^\d{4}$/.test(code)) continue;
    establishments.push({
      code, name,
      teams35: parseInt(cells[3], 10) || 0,
      teams45: parseInt(cells[5], 10) || 0,
      teams55: parseInt(cells[7], 10) || 0,
    });
  }
  return establishments;
}

async function seedTeams(routeLetters) {
  const configDir = path.join(ROOT, "data", year);
  await fs.mkdir(configDir, { recursive: true });

  console.log(`  Fetching teams page...`);
  const teamsHtml = await get(url("page/ten-tors-teams"));
  const establishments = parseTeamsTable(teamsHtml);
  console.log(`  Found ${establishments.length} establishments`);

  // Write teams-raw.json
  const rawPath = path.join(configDir, "teams-raw.json");
  await fs.writeFile(rawPath, JSON.stringify(establishments, null, 2));
  console.log(`  Wrote ${rawPath}`);

  // Load or create config.json
  const configPath = path.join(configDir, "config.json");
  let existing = { year: parseInt(year, 10), routes: {} };
  try {
    existing = JSON.parse(await fs.readFile(configPath, "utf8"));
    console.log(`  Loaded existing config.json (${Object.keys(existing.routes ?? {}).length} routes)`);
  } catch { /* fresh */ }

  const routes = { ...existing.routes };
  for (const letter of routeLetters) {
    if (!routes[letter]) {
      routes[letter] = { label: `Route ${letter}`, distance: null, teams: [], nt_overrides: {}, corrections: [] };
    }
  }

  await fs.writeFile(configPath, JSON.stringify({ year: parseInt(year, 10), routes }, null, 2));
  console.log(`  Wrote ${configPath} (${Object.keys(routes).length} route sections)`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`\n=== Seeding ${year} data from ${baseUrl} ===\n`);

  // 1. Tors
  console.log("Step 1: Fetching control tors...");
  const torsHtml = await get(`${baseUrl}/admin/routes/tors-tt`);
  const torsByName = parseTors(torsHtml);
  console.log(`  Found ${Object.keys(torsByName).length} tors`);

  // 2. Routes → routes.json
  console.log("\nStep 2: Fetching route sequences → routes.json...");
  await seedRoutes(torsByName);

  // 3. Results page → route letters
  console.log("\nStep 3: Fetching results page...");
  const resultsHtml = await get(url("page/results"));
  const routeLetters = parseResultRoutes(resultsHtml);
  console.log(`  Routes on results page: ${routeLetters.join(", ")}`);

  // 4. Teams → config.json + teams-raw.json
  console.log("\nStep 4: Fetching teams...");
  await seedTeams(routeLetters);

  console.log(`
=== Done ===

Next steps for data/${year}/config.json:
  1. Check ${baseUrl}/page/route-allocations to find which
     establishment is on which route letter.
  2. For each route, add team entries from data/${year}/teams-raw.json:
       { "id": "<slug>", "name": "<name>", "match": "<substring>" }
  3. Set "distance" for each route (35, 45, or 55).
  4. Add any known "nt_overrides" for controls with non-standard night times.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
