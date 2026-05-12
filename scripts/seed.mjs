// Seed all data for a given Ten Tors year.
//
// Usage:  node scripts/seed.mjs <year> [--base-url https://www.tentors.org.uk] [--apply-gpx]
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
//   5. Fetches /page/route-allocations → maps establishment → route letter + distance
//      Fully populates data/{year}/config.json with teams in the correct route
//      sections, preserving any existing nt_overrides/corrections per route.
//      Team id = route code lowercased (e.g. "bc"); "match" field not needed.
//      If the page includes GPX/KMZ download links they are stored as gpx_url/kmz_url
//      on each team entry.
//
//   6. (--apply-gpx only) Downloads GPX track files for each route and stores the
//      GPS trail as gpx_track in routes.json, enabling more accurate route geometry
//      on the map.  GPX files are only published by Ten Tors after the event, so
//      this step will fail silently during the event itself.

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
const baseUrlIdx = args.indexOf("--base-url");
const baseUrl = (args.find((a) => a.startsWith("--base-url="))?.split("=")[1]
  ?? (baseUrlIdx !== -1 ? args[baseUrlIdx + 1] : null)
  ?? "https://www.tentors.org.uk").replace(/\/$/, "");
const applyGpx = args.includes("--apply-gpx");

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
// Step 5: route-allocations → fully populate config.json
// ============================================================

function parseRouteAllocations(html) {
  // Returns [{ routeLetter, routeCode, distance, name, gpxUrl, kmzUrl }]
  const tableMatch = html.match(/<table[^>]*class="[^"]*team-overview-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) { console.warn("  No team-overview-table found"); return []; }
  const tbodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) { console.warn("  No <tbody> in route-allocations table"); return []; }
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tbodyMatch[1])) !== null) {
    // Extract raw <td> HTML (before stripping) so we can pull out file URLs.
    const rawCells = [], rawRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let rm;
    while ((rm = rawRe.exec(m[1])) !== null) rawCells.push(rm[1]);

    const cells = rawCells.map(c => stripHtml(c));
    if (cells.length < 3) continue;
    const distStr = cells[0].trim();   // e.g. "TT35"
    const routeCode = cells[1].trim(); // e.g. "BC"
    // Strip KMZ/GPX/KML link text that appears after stripping HTML from the name cell.
    const name = cells[2].replace(/\s*\b(KMZ|GPX|KML)\b\s*/gi, " ").trim();
    if (!distStr || !routeCode || !name) continue;
    const distance = parseInt(distStr.replace(/^TT/i, ""), 10);
    if (isNaN(distance)) continue;
    const routeLetter = routeCode[0].toUpperCase();

    // Extract GPX and KMZ download URLs from the raw name cell HTML.
    const nameCellHtml = rawCells[2] ?? "";
    const gpxMatch = nameCellHtml.match(/href="([^"]*\.gpx)"/i);
    const kmzMatch = nameCellHtml.match(/href="([^"]*\.kmz)"/i);
    const gpxUrl = gpxMatch ? gpxMatch[1] : null;
    const kmzUrl = kmzMatch ? kmzMatch[1] : null;

    rows.push({ routeLetter, routeCode, distance, name, gpxUrl, kmzUrl });
  }
  return rows;
}

async function seedAllocations() {
  const configPath = path.join(ROOT, "data", year, "config.json");
  let config = { year: parseInt(year, 10), routes: {} };
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch { /* fresh */ }

  console.log(`  Fetching route-allocations...`);
  const html = await get(url("page/route-allocations"));
  const rows = parseRouteAllocations(html);
  console.log(`  Found ${rows.length} team allocations`);

  // Build route sections from allocations
  const routes = {};
  for (const { routeLetter, routeCode, distance, name, gpxUrl, kmzUrl } of rows) {
    if (!routes[routeLetter]) {
      const existing = config.routes?.[routeLetter] ?? {};
      routes[routeLetter] = {
        label: `Route ${routeLetter}`,
        distance,
        teams: [],
        nt_overrides: existing.nt_overrides ?? {},
        corrections: existing.corrections ?? [],
      };
    }
    const team = { id: routeCode.toLowerCase(), name };
    if (gpxUrl) team.gpx_url = gpxUrl;
    if (kmzUrl) team.kmz_url = kmzUrl;
    routes[routeLetter].teams.push(team);
  }

  // Preserve any route sections not covered by allocations (e.g. manual entries)
  for (const [letter, data] of Object.entries(config.routes ?? {})) {
    if (!routes[letter]) {
      console.log(`  Preserving existing route section ${letter}`);
      routes[letter] = data;
    }
  }

  const updated = { year: parseInt(year, 10), routes };
  await fs.writeFile(configPath, JSON.stringify(updated, null, 2));
  const teamCount = Object.values(routes).reduce((s, r) => s + r.teams.length, 0);
  console.log(`  Wrote ${configPath} (${Object.keys(routes).length} routes, ${teamCount} teams)`);
}

// ============================================================
// Step 6 (optional --apply-gpx): Download GPX track files and
// replace straight-line waypoint segments in routes.json with
// the actual GPS trail data.
//
// GPX files are published by Ten Tors after (not during) the event.
// Each team has its own file: /eventdata/team{CODE}.gpx
// Teams on the same route share the same track; we use the first
// team per route that has a gpx_url recorded in config.json.
// ============================================================

async function applyGpxRoutes() {
  const configPath = path.join(ROOT, "data", year, "config.json");
  const routesPath = path.join(ROOT, "routes.json");

  let config, routesJson;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
    routesJson = JSON.parse(await fs.readFile(routesPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not read config or routes.json: ${e.message}`);
  }

  let updated = 0;
  for (const [letter, route] of Object.entries(config.routes ?? {})) {
    // Resolve GPX URL: prefer stored gpx_url on any team, fall back to conventional pattern.
    const teamWithUrl = (route.teams ?? []).find(t => t.gpx_url);
    let gpxUrl = teamWithUrl?.gpx_url;
    if (!gpxUrl) {
      const firstTeam = (route.teams ?? [])[0];
      if (!firstTeam) continue;
      gpxUrl = `${baseUrl}/eventdata/team${firstTeam.id.toUpperCase()}.gpx`;
      console.log(`  Route ${letter}: trying conventional URL ${gpxUrl}`);
    }

    let gpxText;
    try {
      const r = await fetch(gpxUrl, { headers: { "User-Agent": "tentors-tracker/0.1" } });
      if (!r.ok) { console.warn(`  Route ${letter}: GPX fetch ${r.status} — skipping`); continue; }
      gpxText = await r.text();
    } catch (e) {
      console.warn(`  Route ${letter}: GPX fetch failed (${e.message}) — skipping`);
      continue;
    }

    // Parse <trkpt lat="..." lon="..."> elements in order
    const trkpts = [];
    const trkRe = /<trkpt\s[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"/gi;
    let tm;
    while ((tm = trkRe.exec(gpxText)) !== null) {
      trkpts.push({ lat: parseFloat(tm[1]), lon: parseFloat(tm[2]) });
    }
    if (!trkpts.length) { console.warn(`  Route ${letter}: no <trkpt> points found — skipping`); continue; }

    // Store the track points alongside the existing waypoints in routes.json
    if (!routesJson[letter]) { console.warn(`  Route ${letter}: not in routes.json — skipping`); continue; }
    routesJson[letter].gpx_track = trkpts;
    console.log(`  Route ${letter}: ${trkpts.length} track points from ${gpxUrl}`);
    updated++;
  }

  await fs.writeFile(routesPath, JSON.stringify(routesJson, null, 2));
  console.log(`  Updated routes.json with GPX tracks for ${updated} route(s)`);
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

  // 4. Teams → teams-raw.json + config.json skeleton
  console.log("\nStep 4: Fetching teams...");
  await seedTeams(routeLetters);

  // 5. Route allocations → fully populate config.json
  console.log("\nStep 5: Fetching route allocations...");
  await seedAllocations();

  // 6. (optional) Apply GPX track data → routes.json
  if (applyGpx) {
    console.log("\nStep 6: Applying GPX route tracks...");
    await applyGpxRoutes();
  }

  console.log(`
=== Done ===

data/${year}/config.json has been fully populated.
If any establishment names differ from what eventdata uses, add a "match"
field to that team entry with the substring eventdata uses instead.
Add "nt_overrides" for controls with non-standard night times if needed.
${applyGpx ? "" : "Re-run with --apply-gpx after the event to add accurate GPS track data to routes.json.\n"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
