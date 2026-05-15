// Unit tests for seed.mjs parser functions.
// Run with: node --test tests/seed.test.mjs
// These catch upstream HTML structure changes before they silently corrupt seeded data.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTors, parseRouteTables, parseTeamsTable,
  parseRouteAllocations, gridRefToLatLon, stripSuffix,
} from "../scripts/seed.mjs";

// ---- gridRefToLatLon ----

test("gridRefToLatLon: converts a known OS grid ref to lat/lon", () => {
  // High Willhays: SX 5809 8920 ≈ 50.692°N, 3.978°W
  const { lat, lon } = gridRefToLatLon("SX 5809 8920");
  assert.ok(lat > 50.68 && lat < 50.70, `lat ${lat} out of range`);
  assert.ok(lon > -4.02 && lon < -3.96, `lon ${lon} out of range`);
});

test("gridRefToLatLon: throws on invalid grid ref", () => {
  assert.throws(() => gridRefToLatLon("INVALID"), /Bad grid ref/);
});

// ---- stripSuffix ----

test("stripSuffix: removes [SC] suffix", () => {
  assert.equal(stripSuffix("YES TOR [SC]"), "YES TOR");
});

test("stripSuffix: removes [SC*] suffix", () => {
  assert.equal(stripSuffix("KES TOR [SC*]"), "KES TOR");
});

test("stripSuffix: removes [BC] suffix", () => {
  assert.equal(stripSuffix("COSDON HILL [BC]"), "COSDON HILL");
});

test("stripSuffix: leaves plain names unchanged", () => {
  assert.equal(stripSuffix("HIGH WILLHAYS"), "HIGH WILLHAYS");
});

// ---- parseTors ----

const TORS_HTML = `
  <tr><th>Name</th><th>Routes</th><th>Grid Ref</th></tr>
  <tr><td>HIGH WILLHAYS</td><td>55</td><td>SX 5809 8920</td></tr>
  <tr><td>YES TOR</td><td>55,45</td><td>SX 5802 8999</td></tr>
  <tr><td>Bad Row</td><td>only two cells</td></tr>
  <tr><td>NO GRIDREF</td><td>x</td><td>not a grid ref</td></tr>
`;

test("parseTors: extracts valid tors with coordinates", () => {
  const result = parseTors(TORS_HTML);
  assert.ok(result["HIGH WILLHAYS"], "HIGH WILLHAYS missing");
  assert.ok(result["YES TOR"], "YES TOR missing");
  assert.equal(typeof result["HIGH WILLHAYS"].lat, "number");
  assert.equal(typeof result["HIGH WILLHAYS"].lon, "number");
});

test("parseTors: skips rows with invalid grid refs", () => {
  const result = parseTors(TORS_HTML);
  assert.ok(!result["NO GRIDREF"], "should have skipped invalid grid ref");
  assert.ok(!result["Bad Row"], "should have skipped short row");
});

test("parseTors: normalises names to uppercase", () => {
  const result = parseTors(`<tr><td>High Willhays</td><td>x</td><td>SX 5809 8920</td></tr>`);
  assert.ok(result["HIGH WILLHAYS"]);
});

// ---- parseRouteTables ----

const ROUTES_HTML = `
  <h2>Route A</h2>
  <table class="table-route">
    <tr class="waypoint-main"><td></td><td>HIGH WILLHAYS</td></tr>
    <tr class="waypoint-via"><td></td><td>YES TOR</td></tr>
    <tr class="waypoint-main"><td></td><td>OKE CAMP</td></tr>
  </table>
  <h2>Route B</h2>
  <table class="table-route">
    <tr class="waypoint-main"><td></td><td>KES TOR [SC]</td></tr>
  </table>
`;

test("parseRouteTables: extracts routes by letter", () => {
  const result = parseRouteTables(ROUTES_HTML);
  assert.ok(result["A"], "Route A missing");
  assert.ok(result["B"], "Route B missing");
});

test("parseRouteTables: extracts waypoints in order", () => {
  const result = parseRouteTables(ROUTES_HTML);
  assert.equal(result["A"][0].rawName, "HIGH WILLHAYS");
  assert.equal(result["A"][1].rawName, "YES TOR");
});

test("parseRouteTables: marks via waypoints", () => {
  const result = parseRouteTables(ROUTES_HTML);
  assert.equal(result["A"][0].via, false);
  assert.equal(result["A"][1].via, true);
});

test("parseRouteTables: skips OKE CAMP rows", () => {
  const result = parseRouteTables(ROUTES_HTML);
  assert.ok(!result["A"].find(w => w.rawName === "OKE CAMP"), "OKE CAMP should be skipped");
});

// ---- parseTeamsTable ----

const TEAMS_HTML = `
  <tbody>
    <tr>
      <td>1234</td><td>Test Academy</td><td>x</td>
      <td>2</td><td>x</td><td>1</td><td>x</td><td>1</td><td>x</td>
    </tr>
    <tr>
      <td>5678</td><td>Another School</td><td>x</td>
      <td>3</td><td>x</td><td>0</td><td>x</td><td>2</td><td>x</td>
    </tr>
    <tr><td>bad</td><td>Not a 4-digit code</td></tr>
    <tr><td>only</td><td>two</td></tr>
  </tbody>
`;

test("parseTeamsTable: extracts establishments", () => {
  const result = parseTeamsTable(TEAMS_HTML);
  assert.equal(result.length, 2);
  assert.equal(result[0].code, "1234");
  assert.equal(result[0].name, "Test Academy");
});

test("parseTeamsTable: parses team counts", () => {
  const result = parseTeamsTable(TEAMS_HTML);
  assert.equal(result[0].teams35, 2);
  assert.equal(result[0].teams45, 1);
  assert.equal(result[0].teams55, 1);
  assert.equal(result[1].teams35, 3);
  assert.equal(result[1].teams55, 2);
});

test("parseTeamsTable: skips rows without 4-digit codes", () => {
  const result = parseTeamsTable(TEAMS_HTML);
  assert.ok(!result.find(e => e.name === "Not a 4-digit code"));
});

// ---- parseRouteAllocations ----

const ALLOC_HTML = `
  <table class="team-overview-table">
    <tbody>
      <tr>
        <td>TT55</td><td>BC</td>
        <td>Barracuda Academy <a href="/eventdata/teamBC.gpx">GPX</a> <a href="/eventdata/teamBC.kmz">KMZ</a></td>
      </tr>
      <tr>
        <td>TT35</td><td>AA</td>
        <td>Some School</td>
      </tr>
      <tr><td>bad</td><td></td></tr>
    </tbody>
  </table>
`;

test("parseRouteAllocations: extracts team allocations", () => {
  const result = parseRouteAllocations(ALLOC_HTML);
  assert.equal(result.length, 2);
  assert.equal(result[0].routeCode, "BC");
  assert.equal(result[0].routeLetter, "B");
  assert.equal(result[0].distance, 55);
  assert.equal(result[0].name, "Barracuda Academy");
});

test("parseRouteAllocations: extracts GPX and KMZ URLs", () => {
  const result = parseRouteAllocations(ALLOC_HTML);
  assert.equal(result[0].gpxUrl, "/eventdata/teamBC.gpx");
  assert.equal(result[0].kmzUrl, "/eventdata/teamBC.kmz");
});

test("parseRouteAllocations: handles missing download links", () => {
  const result = parseRouteAllocations(ALLOC_HTML);
  assert.equal(result[1].gpxUrl, null);
  assert.equal(result[1].kmzUrl, null);
});

test("parseRouteAllocations: strips GPX/KMZ text from team name", () => {
  const result = parseRouteAllocations(ALLOC_HTML);
  assert.ok(!result[0].name.includes("GPX"), "GPX should be stripped from name");
  assert.ok(!result[0].name.includes("KMZ"), "KMZ should be stripped from name");
});
