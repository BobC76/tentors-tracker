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
server.mjs          # Local dev server (proxies /api/route/:letter to tentors.org.uk)
index.html          # Landing page / team search
tracker.html        # Main tracker UI (map, checkpoints, predictions)
api/                # Vercel serverless functions (CORS proxy, version endpoint)
data/               # Seeded JSON: routes.json, data/<year>/config.json, teams-raw.json, tracks.json
scripts/seed.mjs    # Seeds route + team data for a given year
routes.json         # Waypoint lat/lon for all routes (shared across years)
vercel.json         # Vercel routing config
.github/workflows/  # GitHub Actions (seed workflow)
vendor/             # Vendored third-party JS — do not modify
```

## Safe to edit

- `index.html`, `tracker.html` — UI changes
- `server.mjs` — local dev server behaviour
- `api/` — Vercel serverless functions
- `scripts/seed.mjs` — seeding logic
- `data/years.json` — year selector config
- `data/<year>/config.json` — route/team config (corrections, nt_overrides)

## Do not modify

- `vendor/` — vendored libraries, update via npm only
- `data/<year>/teams-raw.json` — raw seeded data, regenerate via `node scripts/seed.mjs <year>` instead
- `data/<year>/tracks.json` — generated GPX data, regenerate via `node scripts/seed.mjs <year> --apply-gpx`

## Conventions

- No build step — plain HTML/CSS/JS, no bundler
- ES modules throughout (`import`/`export`, `.mjs` extension for Node scripts)
- Vercel serverless functions in `api/` use CommonJS (`require`) for compatibility
- Commit directly to `main` for maintainer changes; use a branch + PR for anything experimental
- Keep `data/` changes out of PRs unless the fix is specifically about data correctness

## Key behaviour to understand before changing prediction logic

- The tracker polls every 30 seconds during the event weekend (auto-detected), once daily otherwise
- `event_active` in `data/years.json` can override the auto-detection
- NT cut-off logic: teams that can't reach the next waypoint before overnight cut-off are predicted to camp; the first such waypoint is the overnight camp
- DNF: explicit from results page, or implied if still unfinished after Sunday 17:00
- Resilient fetching: always fall back to last successful data if upstream is slow

## Deployment

Merging to `main` triggers an automatic Vercel deployment. No manual deploy step needed.
