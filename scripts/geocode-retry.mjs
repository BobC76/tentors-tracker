// Retry only waypoints that have lat==null in waypoints.json.
// Uses longer backoff and a name-regex fallback.

import fs from "node:fs/promises";
import path from "node:path";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const BBOX = [50.45, -4.20, 50.75, -3.70];
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "Accept": "application/json",
  "User-Agent": "tentors-tracker/0.1 (bob.campbell@resillion.com)",
};

function exactQuery(name) {
  const [s, w, n, e] = BBOX;
  return `[out:json][timeout:60];
(
  node["name"="${name}"](${s},${w},${n},${e});
  way["name"="${name}"](${s},${w},${n},${e});
  relation["name"="${name}"](${s},${w},${n},${e});
);
out center 5;`;
}

function fuzzyQuery(name) {
  // Case-insensitive, also match alt_name.
  const [s, w, n, e] = BBOX;
  return `[out:json][timeout:60];
(
  node["name"~"${name}",i](${s},${w},${n},${e});
  way["name"~"${name}",i](${s},${w},${n},${e});
  node["alt_name"~"${name}",i](${s},${w},${n},${e});
  way["alt_name"~"${name}",i](${s},${w},${n},${e});
);
out center 10;`;
}

async function call(body, attempt = 1) {
  const r = await fetch(OVERPASS, { method: "POST", headers: HEADERS, body: "data=" + encodeURIComponent(body) });
  if (r.status === 429 || r.status === 504) {
    if (attempt > 4) throw new Error(`HTTP ${r.status} after ${attempt} attempts`);
    const wait = 5000 * attempt;
    console.log(`  retry in ${wait}ms (HTTP ${r.status})`);
    await new Promise((res) => setTimeout(res, wait));
    return call(body, attempt + 1);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function pick(elements) {
  if (!elements?.length) return null;
  const peak = elements.find((el) => el.type === "node" && el.tags?.natural === "peak");
  const e = peak ?? elements[0];
  return {
    lat: e.lat ?? e.center?.lat,
    lon: e.lon ?? e.center?.lon,
    raw: e,
    candidates: elements.length,
  };
}

async function main() {
  const wpPath = path.join(process.cwd(), "waypoints.json");
  const wps = JSON.parse(await fs.readFile(wpPath, "utf-8"));

  for (const wp of wps) {
    if (wp.lat != null) continue;
    const name = wp.osm_query;
    console.log(`Retry: ${wp.label} ("${name}")`);

    // Try exact first.
    let hit = null;
    try {
      const j = await call(exactQuery(name));
      hit = pick(j.elements);
      if (hit) console.log(`  exact match (${hit.raw.type} ${hit.raw.id})`);
    } catch (e) {
      console.log(`  exact failed: ${e.message}`);
    }

    // Fallback: fuzzy.
    if (!hit) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const j = await call(fuzzyQuery(name));
        hit = pick(j.elements);
        if (hit) console.log(`  fuzzy match: ${hit.raw.tags?.name ?? "?"} (${hit.raw.type} ${hit.raw.id}, ${hit.candidates} candidates)`);
      } catch (e) {
        console.log(`  fuzzy failed: ${e.message}`);
      }
    }

    if (hit) {
      wp.lat = hit.lat;
      wp.lon = hit.lon;
      wp.osm_type = hit.raw.type;
      wp.osm_id = hit.raw.id;
      wp.osm_tags = hit.raw.tags ?? {};
      delete wp.error;
      console.log(`  → ${hit.lat.toFixed(6)}, ${hit.lon.toFixed(6)}  tags=${JSON.stringify(hit.raw.tags ?? {})}`);
    } else {
      console.log("  STILL NOT FOUND");
    }

    await new Promise((r) => setTimeout(r, 2500));
  }

  await fs.writeFile(wpPath, JSON.stringify(wps, null, 2));
  const missing = wps.filter((w) => w.lat == null);
  console.log(`\nRemaining missing: ${missing.length}`);
  for (const m of missing) console.log(`  - ${m.label}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
