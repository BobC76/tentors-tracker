// Geocode Ten Tors Route E waypoints via OSM Overpass API.
// Writes waypoints.json with { name, lat, lon, source, raw }.

import fs from "node:fs/promises";
import path from "node:path";

const OVERPASS = "https://overpass-api.de/api/interpreter";

// Dartmoor bounding box (south, west, north, east)
const BBOX = [50.45, -4.20, 50.75, -3.70];

// Route E waypoints in order. Some have OSM-friendly aliases.
// `via: true` means "pass-through" (intermediate waypoint).
const WAYPOINTS = [
  { label: "START",            fixed: { lat: 50.71680569, lon: -4.00212532 } },
  { label: "OKE TOR",          osm: "Oke Tor",          via: true },
  { label: "OKEMENT HILL",     osm: "Okement Hill" },
  { label: "WATERN TOR",       osm: "Watern Tor" },
  { label: "FERNWORTHY",       osm: "Fernworthy Reservoir" },
  { label: "SITTAFORD TOR",    osm: "Sittaford Tor",    via: true },
  { label: "WATER HILL",       osm: "Water Hill" },
  { label: "POSTBRIDGE",       osm: "Postbridge",       via: true },
  { label: "HIGHER WHITE TOR", osm: "Higher White Tor" },
  { label: "HOLMING BEAM",     osm: "Holming Beam" },
  { label: "WHITE BARROW",     osm: "White Barrow",     via: true },
  { label: "STANDON FARM",     osm: "Standon Farm" },
  { label: "HARE TOR",         osm: "Hare Tor" },
  { label: "NODDEN GATE",      osm: "Nodden Gate" },
  { label: "KITTY TOR",        osm: "Kitty Tor",        via: true },
  { label: "EAST MILL TOR",    osm: "East Mill Tor" },
  { label: "FINISH",           fixed: { lat: 50.71788492, lon: -4.00205018 } },
];

function overpassQuery(name) {
  // Match nodes/ways/relations whose name equals `name` within bbox.
  const [s, w, n, e] = BBOX;
  return `[out:json][timeout:25];
(
  node["name"="${name}"](${s},${w},${n},${e});
  way["name"="${name}"](${s},${w},${n},${e});
  relation["name"="${name}"](${s},${w},${n},${e});
);
out center 5;`;
}

async function lookup(name) {
  const body = overpassQuery(name);
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "tentors-tracker/0.1 (bob.campbell@resillion.com)",
    },
    body: "data=" + encodeURIComponent(body),
  });
  if (!r.ok) throw new Error(`Overpass HTTP ${r.status} for ${name}`);
  const j = await r.json();
  if (!j.elements?.length) return null;

  // Prefer natural=peak nodes if present, else first element.
  const peak = j.elements.find(
    (el) => el.type === "node" && el.tags?.natural === "peak"
  );
  const pick = peak ?? j.elements[0];
  const lat = pick.lat ?? pick.center?.lat;
  const lon = pick.lon ?? pick.center?.lon;
  return { lat, lon, raw: pick };
}

async function main() {
  const out = [];
  for (const wp of WAYPOINTS) {
    if (wp.fixed) {
      out.push({
        label: wp.label,
        lat: wp.fixed.lat,
        lon: wp.fixed.lon,
        via: !!wp.via,
        source: "user",
      });
      console.log(`[fixed] ${wp.label} → ${wp.fixed.lat}, ${wp.fixed.lon}`);
      continue;
    }
    process.stdout.write(`[osm  ] ${wp.label.padEnd(18)} `);
    try {
      const hit = await lookup(wp.osm);
      if (!hit) {
        console.log("NOT FOUND");
        out.push({ label: wp.label, lat: null, lon: null, via: !!wp.via, source: "osm", osm_query: wp.osm, error: "not_found" });
      } else {
        console.log(`→ ${hit.lat.toFixed(6)}, ${hit.lon.toFixed(6)}  [${hit.raw.type} ${hit.raw.id}, tags=${JSON.stringify(hit.raw.tags ?? {})}]`);
        out.push({
          label: wp.label,
          lat: hit.lat,
          lon: hit.lon,
          via: !!wp.via,
          source: "osm",
          osm_query: wp.osm,
          osm_type: hit.raw.type,
          osm_id: hit.raw.id,
          osm_tags: hit.raw.tags ?? {},
        });
      }
    } catch (err) {
      console.log("ERROR:", err.message);
      out.push({ label: wp.label, lat: null, lon: null, via: !!wp.via, source: "osm", osm_query: wp.osm, error: err.message });
    }
    // Polite pause for Overpass.
    await new Promise((res) => setTimeout(res, 1100));
  }

  const outPath = path.join(process.cwd(), "waypoints.json");
  await fs.writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);

  const missing = out.filter((w) => w.lat == null);
  if (missing.length) {
    console.log(`\n${missing.length} waypoint(s) not resolved:`);
    for (const m of missing) console.log(`  - ${m.label} (queried "${m.osm_query}")`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
