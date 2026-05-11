// Fetch Ten Tors team/establishment list and write a staging file.
//
// Usage:  node scripts/fetch-teams.mjs <year> [--base-url https://www.tentors.org.uk]
//
// The /page/ten-tors-teams table lists all establishments with team counts
// per distance (35/45/55 mile), but does NOT include route-letter assignment.
// Route letters come from /page/route-allocations (check that page manually).
//
// Outputs:
//   data/{year}/teams-raw.json  — flat list of all establishments + team counts
//   data/{year}/config.json     — created/updated if not present; route sections
//                                 are left empty for manual route assignment.
//
// To populate config.json after this script:
//   1. Check https://www.tentors.org.uk/page/route-allocations for route letters.
//   2. For each route in config.json, add teams from teams-raw.json.
//   3. Set the "match" field to a substring of the name as it appears in the
//      eventdata table (usually the first distinctive word(s)).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const year = args.find((a) => /^\d{4}$/.test(a));
if (!year) {
  console.error("Usage: node scripts/fetch-teams.mjs <year> [--base-url <url>]");
  process.exit(1);
}

const baseUrl = (args.find((a) => a.startsWith("--base-url="))?.split("=")[1]
  ?? args[args.indexOf("--base-url") + 1]
  ?? "https://www.tentors.org.uk").replace(/\/$/, "");

const currentYear = new Date().getFullYear().toString();
const isArchive = year !== currentYear;

function teamsUrl() {
  return isArchive
    ? `${baseUrl}/archive/${year}/page/ten-tors-teams.html`
    : `${baseUrl}/page/ten-tors-teams`;
}

function resultsUrl() {
  return isArchive
    ? `${baseUrl}/archive/${year}/page/results.html`
    : `${baseUrl}/page/results`;
}

async function fetchPage(url) {
  console.log(`  GET ${url}`);
  const r = await fetch(url, { headers: { "User-Agent": "tentors-tracker/0.1" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&nbsp;/g, " ").trim();
}

function extractCells(rowHtml) {
  const cells = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) cells.push(stripHtml(m[1]));
  return cells;
}

// Parse the results page to find which route letters exist.
function parseResultRoutes(html) {
  const letters = new Set();
  const re = /eventdata\/route([a-zA-Z])\.html/gi;
  let m;
  while ((m = re.exec(html)) !== null) letters.add(m[1].toUpperCase());
  return [...letters].sort();
}

// Parse the .teamtable on /page/ten-tors-teams.
// Table structure (from actual HTML):
//   thead rows (skip): Code | Establishment | Paid | 35-Alloc | 35-Resv | 45-Alloc | 45-Resv | 55-Alloc | 55-Resv | Queries
//   tbody rows: same columns
//
// We look at cells[3] (35 alloc), cells[5] (45 alloc), cells[7] (55 alloc)
// to determine how many teams each establishment has at each distance.
function parseTeamsTable(html) {
  const establishments = [];

  // Extract tbody section.
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) {
    console.warn("  No <tbody> found in teams table");
    return establishments;
  }

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tbodyMatch[1])) !== null) {
    const cells = extractCells(m[1]);
    // Expect at least 9 cells: code, name, paid, 35a, 35r, 45a, 45r, 55a, 55r [, queries]
    if (cells.length < 9) continue;
    const code = cells[0].trim();
    const name = cells[1].trim();
    if (!name || !/^\d{4}$/.test(code)) continue; // skip totals rows etc.

    const teams35 = parseInt(cells[3], 10) || 0;
    const teams45 = parseInt(cells[5], 10) || 0;
    const teams55 = parseInt(cells[7], 10) || 0;

    establishments.push({ code, name, teams35, teams45, teams55 });
  }

  return establishments;
}

function toId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main() {
  console.log(`\nFetching ${year} team data from ${baseUrl}\n`);

  // 1. Fetch results page to discover route letters
  console.log("1. Fetching results page...");
  const routeLetters = await fetchPage(resultsUrl()).then(parseResultRoutes);
  console.log(`   Routes: ${routeLetters.join(", ")}`);

  // 2. Fetch teams page
  console.log("\n2. Fetching teams page...");
  const teamsHtml = await fetchPage(teamsUrl());
  const establishments = parseTeamsTable(teamsHtml);
  console.log(`   Found ${establishments.length} establishments`);

  if (establishments.length === 0) {
    console.error("  No establishments parsed — check HTML format.");
    process.exit(1);
  }

  const configDir = path.join(ROOT, "data", year);
  await fs.mkdir(configDir, { recursive: true });

  // 3. Write teams-raw.json — full flat list
  const rawPath = path.join(configDir, "teams-raw.json");
  await fs.writeFile(rawPath, JSON.stringify(establishments, null, 2));
  console.log(`\nWrote ${rawPath} (${establishments.length} establishments)`);

  // 4. Create or update config.json
  //    - Preserve existing nt_overrides/corrections/teams if config already exists
  //    - Add any new route letters that don't yet have a section
  const configPath = path.join(configDir, "config.json");
  let existing = { year: parseInt(year, 10), routes: {} };
  try {
    existing = JSON.parse(await fs.readFile(configPath, "utf8"));
    console.log(`   Loaded existing config.json (${Object.keys(existing.routes ?? {}).length} routes)`);
  } catch {
    console.log("   No existing config.json — creating");
  }

  const routes = { ...existing.routes };
  for (const letter of routeLetters) {
    if (!routes[letter]) {
      routes[letter] = {
        label: `Route ${letter}`,
        distance: null, // fill in from route-allocations or manually
        teams: [],      // fill in from teams-raw.json after checking route-allocations
        nt_overrides: {},
        corrections: [],
      };
    }
  }

  const config = { year: parseInt(year, 10), routes };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`   Wrote ${configPath} (${Object.keys(routes).length} route sections)`);

  console.log(`
Next steps:
  1. Check ${baseUrl}/page/route-allocations to find which establishment is on which route.
  2. For each route in data/${year}/config.json, add team entries from teams-raw.json:
       { "id": "<slug>", "name": "<Establishment name>", "match": "<substring>" }
  3. Set "distance" for each route (35, 45, or 55).
  4. Run "node scripts/fetch-waypoints.mjs" if routes.json needs updating.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
