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
  - Tent marker showing overnight camp location (first NT cut-off the team can't reach in time)
  - 🏁 ETA at finish with a ±30 min confidence range
  - ⏱️ "Approaching finish" when pace puts a team at the finish but no confirmation is recorded yet
- **DNF detection** — teams marked "DID NOT FINISH" in the results page show red with no ETA; teams still unfinished after Sunday 17:00 are treated as implied DNF
- **Per-team GPS tracks** — after the event, each team's actual GPS recording is shown as their route line (post-event only; straight waypoint segments are used during the event)
- **Accurate elevation** — GPS altitude is replaced with ASTER 30m DEM data during seeding, giving ascent figures that match Garmin/RideWithGPS
- **Resilient fetching** — if tentors.org.uk is slow or temporarily unavailable, the tracker falls back to the last successfully fetched data and shows a warning
- **Multi-year** — archive years are accessible via the year selector

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

## Year lifecycle (automatic)

From 2027 onwards, everything is handled by the `auto-seed` GitHub Actions workflow, which runs weekly year-round and daily throughout May:

1. Seeds the current year's teams, routes, and waypoints from tentors.org.uk
2. Once post-event GPX files appear, automatically downloads them and applies DEM elevation correction
3. Updates `data/years.json` so the new year becomes current and old years become archive
4. Commits changes and pushes — Vercel redeploys automatically

**No manual steps are needed.** If the workflow fails (upstream down, HTML structure changed, etc.), GitHub sends a failure email.

## Seeding data manually

If you need to reseed outside the automated schedule:

```
node scripts/seed.mjs <year>
```

Or trigger it from the **Actions** tab on GitHub (→ *Seed year data* → *Run workflow*) — no terminal needed.

This fetches from tentors.org.uk and writes:
- `routes.json` — waypoint lat/lon for all routes (shared across years)
- `data/<year>/teams-raw.json` — raw establishment list
- `data/<year>/config.json` — route sections with teams fully populated

After seeding, `data/years.json` is updated automatically via `scripts/update-years.mjs`.

### Applying GPX track data (post-event)

After the event, Ten Tors publishes per-team GPX files. Run with `--apply-gpx` to download them and replace the straight waypoint lines with actual GPS trails:

```
node scripts/seed.mjs <year> --apply-gpx
```

Or use `--auto-gpx` to apply GPX only if URLs are present and tracks haven't been applied yet (what the auto-seed workflow uses).

This writes per-team track arrays into `data/<year>/tracks.json`. GPS altitude in the raw GPX files is inaccurate (±50 m) — the seed automatically queries the [ASTER 30m DEM](https://www.opentopodata.org) (free, no API key) to replace every track point and waypoint elevation with accurate terrain data. This takes roughly 5–15 minutes depending on team count (API rate limit: 1 req/sec, 100 points/req).

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

## Attribution & disclaimer

- Route and results data © [Ten Tors](https://tentors.org.uk)
- Map tiles © [OpenStreetMap](https://openstreetmap.org/copyright) contributors
- This project is not affiliated with or endorsed by the Ten Tors organisation or the British Army
