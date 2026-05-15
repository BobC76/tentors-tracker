# Claude Code instructions for tentors-tracker

This file tells Claude Code how to work in this repo. Read it before making any changes.

## What this project is

A live tracker for the [Ten Tors](https://tentors.org.uk) challenge on Dartmoor. It fetches checkpoint results from tentors.org.uk, plots teams on a map, and predicts finish times. Deployed on Vercel.

## How to run locally

```
npm install
PORT=3001 node server.mjs   # Mac/Linux
set PORT=3001 && node server.mjs  # Windows
```

Open http://localhost:3001/

Route T has a synthetic "Test Team" injected that advances through checkpoints every 30 seconds — use this for testing live behaviour.

## Project structure

```
server.mjs               # Local dev server (proxies /api/route/:letter to tentors.org.uk)
index.html               # Landing page / team search
tracker.html             # Main tracker UI (map, checkpoints, predictions)
api/                     # Vercel serverless functions (CORS proxy, version endpoint)
data/years.json          # Year selector config — auto-managed by update-years.mjs
data/<year>/config.json  # Route sections + teams for a given year
data/<year>/tracks.json  # Per-team GPX track data (generated, post-event only)
data/<year>/teams-raw.json # Raw establishment list (generated)
routes.json              # Waypoint lat/lon for all routes (shared across years, DEM-corrected)
scripts/seed.mjs         # Seeds route + team data for a given year
scripts/update-years.mjs # Updates data/years.json when a new year is seeded
tests/                   # Node built-in test runner — seed parser tests
vercel.json              # Vercel routing config
.github/workflows/       # CI (syntax + tests), auto-seed (weekly), manual seed
vendor/                  # Vendored third-party JS — do not modify
```

## Safe to edit

- `index.html`, `tracker.html` — UI changes
- `server.mjs` — local dev server behaviour
- `api/` — Vercel serverless functions
- `scripts/seed.mjs` — seeding logic
- `scripts/update-years.mjs` — years.json management
- `data/years.json` — year selector config (also auto-managed)
- `data/<year>/config.json` — route/team config (corrections, nt_overrides)

## Do not modify

- `vendor/` — vendored libraries, update via npm only
- `data/<year>/teams-raw.json` — raw seeded data, regenerate via `node scripts/seed.mjs <year>` instead
- `data/<year>/tracks.json` — generated GPX data, regenerate via `node scripts/seed.mjs <year> --apply-gpx`

## Conventions

- No build step — plain HTML/CSS/JS, no bundler
- ES modules throughout (`import`/`export`, `.mjs` for Node scripts, ESM in `api/` too)
- Commit directly to `main` for maintainer changes; use a branch + PR for anything experimental
- Keep `data/` changes out of PRs unless the fix is specifically about data correctness
- Run tests before pushing: `node --test tests/seed.test.mjs`

## Key behaviour to understand before changing prediction logic

- The tracker polls every 30 seconds during the event weekend (auto-detected), once daily otherwise
- `event_active` in `data/years.json` can override the auto-detection
- NT cut-off logic: teams that can't reach the next waypoint before overnight cut-off are predicted to camp; the first such waypoint is the overnight camp
- DNF: explicit from results page, or implied if still unfinished after Sunday 17:00
- Resilient fetching: always fall back to last successful data if upstream is slow
- Elevation: track points and waypoints are DEM-corrected (ASTER 30m via opentopodata.org) during seeding — re-seeding preserves existing ele values so they aren't wiped

## Year lifecycle (fully automatic from 2027)

The `auto-seed` GitHub Actions workflow runs weekly (+ daily in May) and:
1. Seeds the current calendar year's teams/routes
2. Applies GPX + DEM correction automatically once post-event files appear
3. Updates `data/years.json` via `scripts/update-years.mjs`
4. Commits and pushes — Vercel redeploys automatically

No manual steps needed. Workflow failure = email notification = something genuinely broken.

## Deployment

Merging to `main` triggers an automatic Vercel deployment. No manual deploy step needed.
