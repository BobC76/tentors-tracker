# Contributing to Ten Tors Tracker

Thanks for wanting to help! This is a hobby project by a Ten Tors parent, so contributions are welcome but please keep expectations relaxed — I review in my spare time.

## What kind of contributions are welcome?

- Bug fixes (especially around checkpoint parsing or prediction logic)
- Accuracy improvements to route data or elevation handling
- UI/UX improvements to the tracker or map
- Support for edge cases in Ten Tors results pages

If you're unsure whether something fits, open an issue first and we can discuss it before you spend time coding.

## How to contribute

1. **Fork** the repo and create a branch from `main`:
   ```
   git checkout -b fix/your-description
   ```

2. **Run it locally** to test your changes:
   ```
   npm install
   PORT=3001 node server.mjs   # Mac/Linux
   set PORT=3001 && node server.mjs  # Windows
   ```
   Open http://localhost:3001/ — route T has a synthetic "Test Team" that advances through checkpoints every 30 seconds, useful for testing live behaviour without waiting for an actual event.

3. **Keep changes focused** — one fix or feature per PR makes review much easier.

4. **Open a pull request** against `main` with a clear description of what changed and why.

## Things to be aware of

- `data/` contains seeded JSON files committed to the repo — avoid committing changes to these unless the fix is specifically about data correctness.
- `vendor/` contains vendored third-party libraries — don't modify these.
- The project uses plain HTML/JS and a minimal Node.js server (`server.mjs`) — no build step required.
- Vercel deployment is automatic on merge to `main`.

## Issues

For bugs, please include:
- The route/team/year you were looking at
- What you expected vs what you saw
- Browser and OS if it looks like a display issue

For security issues, please see [SECURITY.md](SECURITY.md) — do not open a public issue.
