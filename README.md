# Ten Tors Route E live tracker

Tracks the Barracuda Explorer Scouts B team on the 2026 Ten Tors 35-mile
Route E. Pulls live waypoint check-in times from
[tentors.org.uk](https://tentors.org.uk/eventdata/routee.html) every 60 s,
extrapolates current position along the route at the team's running pace,
and predicts:

- ⛺ where they'll be told to camp tonight (first NT cut-off they can't make)
- 🏁 ETA at finish, assuming a 07:00 Sunday restart from camp

The route line is extracted from the official Route E PDF (red line on the
OS 1:25k map), pixel-traced, anchored to known waypoint OSGB grid refs, and
hand-corrected for Postbridge's 300 m B3212 section and the Hare Tor →
Nodden Gate approach.

## Run locally

```
npm install
node scripts/build-waypoints.mjs   # writes waypoints.json
node scripts/project-route.mjs     # writes route.geojson + image-bounds.json
npm start                          # http://localhost:3000/verify.html
```

(`scripts/extract-image.mjs` and `scripts/trace-route.mjs` only need to run
once — they pull the map image out of the PDF and trace the red route into
`route-pixels.json`.)

## Deploy

The repo is set up for **Vercel**:
- `api/routee.js` is the serverless function that proxies the upstream HTML
- everything else is static
