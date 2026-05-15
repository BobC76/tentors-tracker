// Updates data/years.json to include the given year as current.
// Only runs if data/<year>/config.json exists (i.e. seed succeeded).
// Marks the given year as current; removes current flag from all others.
// Sorts years descending so the UI shows newest first.
//
// Usage: node scripts/update-years.mjs <year>

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const yearArg = parseInt(process.argv[2], 10);
if (!yearArg || isNaN(yearArg)) {
  console.error("Usage: node scripts/update-years.mjs <year>");
  process.exit(1);
}

// Only update if the year was successfully seeded
try {
  await fs.access(path.join(ROOT, "data", String(yearArg), "config.json"));
} catch {
  console.log(`data/${yearArg}/config.json not found — seed may not have run yet, skipping years.json update`);
  process.exit(0);
}

const yearsPath = path.join(ROOT, "data", "years.json");
let years = [];
try {
  years = JSON.parse(await fs.readFile(yearsPath, "utf8"));
} catch { /* fresh */ }

// Add year if not already present
if (!years.find(y => y.year === yearArg)) {
  years.push({ year: yearArg });
}

// Set current flag: only the given year is current
years = years.map(y => {
  const { current: _, ...rest } = y;
  return y.year === yearArg ? { ...rest, current: true } : rest;
});

// Sort descending
years.sort((a, b) => b.year - a.year);

await fs.writeFile(yearsPath, JSON.stringify(years, null, 2) + "\n");
console.log(`Updated data/years.json: ${years.map(y => y.year + (y.current ? " (current)" : "")).join(", ")}`);
