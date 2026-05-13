# Ten Tors Tracker

A free, independent live tracker for the [Ten Tors](https://tentors.org.uk) challenge on Dartmoor — built as a hobby project by a Ten Tors parent.
Supports all routes (A–Z) and all teams for any event year.

> **Not affiliated with the Ten Tors organisation or the British Army.**
> Checkpoint data is fetched from the official tentors.org.uk results pages.

## What it does

- **Team search** — type a team name or route code to find and select teams; track multiple at once
- **Live map** — shows each team's estimated position along their route, updated every 30 seconds during the event (once daily outside it)
- **Checkpoint times** — pulled from the Ten Tors live results pages; visited checkpoints are highlighted
- **Elevation profile** — sparkline showing the route's elevation, with a progress marker during the event
- **Predictions** — estimates pace from recorded check-ins and projects:
  - ⛺ overnight camp location (first NT cut-off the team can't reach in time)
  - 🏁 ETA at finish with a ±30 min confidence range
  - ⏱️ "Approaching finish" when pace puts a team at the finish but no confirmation is recorded yet
- **DNF detection** — teams marked "DID NOT FINISH" in the results page show red with no ETA; teams still unfinished after Sunday 17:00 are treated as implied DNF
- **Per-team GPS tracks** — after the event, each team's actual GPS recording is shown as their route line (post-event only; straight waypoint segments are used during the event)
- **Resilient fetching** — if tentors.org.uk is slow or temporarily unavailable, the tracker falls back to the last successfully fetched data and shows a warning
- **Multi-year** — archive years are accessible via the year selector once added to `data/years.json`

## Run locally

```
npm install
set PORT=3001 && node server.mjs   # Windows
PORT=3001 node server.mjs          # Mac/Linux
```

Open http://localhost:3001/

The server proxies `/api/route/:letter` to tentors.org.uk to avoid CORS issues.
For local testing, route T has a synthetic "Test Team" injected that advances
through checkpoints every 30 seconds.

## Seeding data for a new year

```
node scripts/seed.mjs <year>
```

Or trigger it from the **Actions** tab on GitHub (→ *Seed year data* → *Run workflow*) — no terminal needed.

This fetches from tentors.org.uk and writes:
- `routes.json` — waypoint lat/lon for all routes (shared across years)
- `data/<year>/teams-raw.json` — raw establishment list
- `data/<year>/config.json` — route sections with teams fully populated from `/page/route-allocations`

After seeding, add the new year to `data/years.json` (see Year management below).

### Applying GPX track data (post-event)

After the event, Ten Tors publishes per-team GPX files. Run with `--apply-gpx` to download them and replace the straight waypoint-to-waypoint lines with the actual GPS trail:

```
node scripts/seed.mjs <year> --apply-gpx
```

Or tick the *Apply GPX* checkbox in the GitHub Actions workflow. This writes per-team track arrays into `data/<year>/tracks.json`; the tracker fetches this file at startup and uses each team's own GPS recording for their route line. Waypoint elevations (used for the in-event sparkline) are also snapped from the GPX data and stored in `routes.json`.

### config.json structure

```json
{
  "year": 2026,
  "routes": {
    "T": {
      "label": "Route T",
      "distance": 45,
      "teams": [
        { "id": "ta", "name": "St Peters School" }
      ],
      "nt_overrides": {},
      "corrections": []
    }
  }
}
```

- `id` — the two-letter route code lowercased (e.g. `"ta"`)
- `name` — establishment name as it appears in the eventdata results table
- `match` — optional substring override if the eventdata spelling differs from the name
- `nt_overrides` — map of `"WAYPOINT LABEL": "HH:MM"` for non-standard NT cut-off times
- `dev_only: true` — hides a team from the public search (used for the local test team)

## Deploy

Hosted on **Vercel**:
- `api/route/[letter].js` — serverless proxy for the upstream results HTML (CORS workaround)
- `api/version.js` — returns the current deploy SHA for auto-reload on redeploy
- everything else is static, served from the repo root

## Year management

`data/years.json` controls the year selector:

```json
[
  { "year": 2026, "current": true }
]
```

- **`current`** — marks the live year; all others show as "archive" in the selector
- **`event_active`** *(optional override)* — the tracker automatically switches to 30-second polling on the event weekend (Saturday–Sunday following the May Day bank holiday). Set `"event_active": true` to force it on, or `false` to force it off, if the event date ever differs.

When the current year appears in the Ten Tors archive (tentors.org.uk/page/archive), add the new year and mark the old one archived:

```json
[
  { "year": 2027, "current": true },
  { "year": 2026, "current": false }
]
```

## Attribution & disclaimer

- Route and results data © [Ten Tors](https://tentors.org.uk)
- Map tiles © [OpenStreetMap](https://openstreetmap.org/copyright) contributors
- This project is not affiliated with or endorsed by the Ten Tors organisation or the British Army
