# Ten Tors Tracker

A live tracker for the [Ten Tors](https://tentors.org.uk) challenge on Dartmoor.
Supports all routes (A–Z) and all teams for any event year.

## What it does

- **Team search** — type a team name or route code to find and select teams; track multiple at once
- **Live map** — shows each team's estimated position along their route, updated every 30 seconds
- **Checkpoint times** — pulled from the Ten Tors live results pages; visited checkpoints are highlighted
- **Predictions** — estimates pace from recorded check-ins and projects:
  - ⛺ overnight camp location (first NT cut-off the team can't reach in time)
  - 🏁 ETA at finish with a ±30 min confidence range
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

This fetches from tentors.org.uk and writes:
- `routes.json` — waypoint lat/lon for all routes (shared across years)
- `data/<year>/teams-raw.json` — raw establishment list
- `data/<year>/config.json` — route sections with teams fully populated from `/page/route-allocations`

After seeding, set `"current": true` for the new year in `data/years.json`
and move the previous year to `"current": false`.

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

## Deploy

Hosted on **Vercel**:
- `api/route/[letter].js` — serverless proxy for the upstream results HTML
- `api/version.js` — returns the current deploy SHA for auto-reload on redeploy
- everything else is static, served from the repo root

## Year management

`data/years.json` controls the year selector on the home page:

```json
[
  { "year": 2026, "current": true }
]
```

When the current year appears in the Ten Tors archive (tentors.org.uk/page/archive),
add the new year as `current` and mark the old one `false`:

```json
[
  { "year": 2027, "current": true },
  { "year": 2026, "current": false }
]
```

## Attribution

- Route and results data © [Ten Tors](https://tentors.org.uk)
- Map tiles © [OpenStreetMap](https://openstreetmap.org/copyright) contributors
