// Fetch the Ten Tors team list and build / update data/{year}/config.json.
//
// Usage:  node scripts/fetch-teams.mjs <year> [--base-url https://www.tentors.org.uk]
//
// For the current year, fetches:
//   /page/ten-tors-teams
// For archive years, fetches:
//   /archive/{year}/page/ten-tors-teams.html
//
// Requires routes.json to already exist (run fetch-waypoints.mjs first).
// The route letter for each team is determined from the results page:
//   /page/results  (current year)  or  /archive/{year}/page/results.html
//
// Writes data/{year}/config.json preserving any existing nt_overrides / corrections.

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
  const r = await fetch(url, {
    headers: { "User-Agent": "tentors-tracker/0.1" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// Parse the results page to find which routes exist (A–Z letters from eventdata links).
function parseResultRoutes(html) {
  const letters = new Set();
  // Look for links like ../eventdata/routeA.html or /eventdata/routeA.html
  const re = /eventdata\/route([a-zA-Z])\.html/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    letters.add(m[1].toUpperCase());
  }
  return [...letters].sort();
}

// Parse the teams page.
// Expected structure: sections per route (e.g. "Route A" heading) with a list/table of team names.
// Returns: { routeLetter: [{ name, match }], ... }
function parseTeamsByRoute(html) {
  const result = {};

  // Strategy: find sections with "Route X" headings, then extract team names beneath them.
  // Headings may be h1–h4 with text like "Route A" or "35 Mile Route A".
  // Team names appear in <li>, <td>, or <p> tags within each section.

  // Split on heading tags containing a route letter.
  const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const sections = [];
  let lastIndex = 0;
  let lastLetter = null;
  let m;

  while ((m = headingRe.exec(html)) !== null) {
    const headingText = m[1].replace(/<[^>]+>/g, "").trim();
    const letterMatch = headingText.match(/\bRoute\s+([A-Z])\b/i)
      ?? headingText.match(/^([A-Z])\s*$/);
    if (letterMatch) {
      if (lastLetter !== null) {
        sections.push({ letter: lastLetter, htmlContent: html.slice(lastIndex, m.index) });
      }
      lastLetter = letterMatch[1].toUpperCase();
      lastIndex = m.index + m[0].length;
    }
  }
  if (lastLetter !== null) {
    sections.push({ letter: lastLetter, htmlContent: html.slice(lastIndex) });
  }

  for (const { letter, htmlContent } of sections) {
    const names = extractNames(htmlContent);
    if (names.length > 0) {
      result[letter] = names;
    }
  }

  return result;
}

// Extract team names from a section of HTML.
// Looks for <li>, <td>, or <p> elements with plausible team names.
function extractNames(html) {
  const names = [];
  const itemRe = /<(?:li|td|p)[^>]*>([\s\S]*?)<\/(?:li|td|p)>/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
    // Filter out empty strings, headings-like text, and very short/long values
    if (text.length < 2 || text.length > 80) continue;
    if (/^\d+$/.test(text)) continue; // pure numbers
    if (/^(route|distance|team|name|school)/i.test(text)) continue; // header cells
    names.push(text);
  }
  return names;
}

// Slugify a team name into a stable id.
function toId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  console.log(`\nFetching ${year} team data from ${baseUrl}\n`);

  // 1. Load existing config if any (to preserve nt_overrides / corrections)
  const configDir  = path.join(ROOT, "data", year);
  const configPath = path.join(configDir, "config.json");
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(configPath, "utf8"));
    console.log(`Loaded existing config.json (${Object.keys(existing.routes ?? {}).length} routes)`);
  } catch {
    console.log("No existing config.json — creating fresh");
  }

  // 2. Load routes.json to know distances
  const routesPath = path.join(ROOT, "routes.json");
  let routesJson = {};
  try {
    routesJson = JSON.parse(await fs.readFile(routesPath, "utf8"));
    console.log(`Loaded routes.json (${Object.keys(routesJson).length} routes)`);
  } catch {
    console.warn("Warning: routes.json not found; distances will be omitted");
  }

  // Distance labels per category (filled from routes.json waypoints count, or fallback)
  // tentors.org.uk uses 35/45/55 mile categories; we'll look it up from config or guess.
  const KNOWN_DISTANCES = { 35: /\b(35|A|B|C|D|E|F|G|H|I|J)\b/, 45: /\b45\b/, 55: /\b55\b/ };

  // 3. Fetch results page to find which routes exist
  console.log(`\nFetching results page...`);
  const resultsHtml = await fetchPage(resultsUrl());
  const routeLetters = parseResultRoutes(resultsHtml);
  console.log(`  Found routes: ${routeLetters.join(", ")}`);

  // 4. Fetch teams page
  console.log(`\nFetching teams page...`);
  const teamsHtml = await fetchPage(teamsUrl());
  const teamsByRoute = parseTeamsByRoute(teamsHtml);
  console.log(`  Parsed teams for routes: ${Object.keys(teamsByRoute).sort().join(", ")}`);

  // 5. Build config
  const routes = {};

  for (const letter of routeLetters) {
    const existingRoute = existing?.routes?.[letter] ?? {};
    const teams = (teamsByRoute[letter] ?? []).map((name) => ({
      id: toId(name),
      name,
      match: name,
    }));

    // Try to infer distance from existing config or leave null for user to fill
    const distance = existingRoute.distance ?? null;

    routes[letter] = {
      label: `Route ${letter}`,
      distance,
      teams: teams.length > 0 ? teams : (existingRoute.teams ?? []),
      nt_overrides: existingRoute.nt_overrides ?? {},
      corrections: existingRoute.corrections ?? [],
    };
  }

  // Preserve routes that exist in the config but weren't in results (edge case)
  for (const [letter, data] of Object.entries(existing?.routes ?? {})) {
    if (!routes[letter]) {
      console.log(`  Preserving manual route ${letter} from existing config`);
      routes[letter] = data;
    }
  }

  const config = {
    year: parseInt(year, 10),
    routes,
  };

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`\nWrote ${configPath}`);
  console.log(`  ${Object.keys(routes).length} routes: ${Object.keys(routes).sort().join(", ")}`);
  const totalTeams = Object.values(routes).reduce((s, r) => s + r.teams.length, 0);
  console.log(`  ${totalTeams} teams total`);

  if (totalTeams === 0) {
    console.warn(`
Warning: No teams were parsed. The teams page HTML structure may not match expectations.
You may need to manually populate the teams arrays in ${configPath}.
`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
