// Minimal static + proxy server.
// Serves the project root and proxies /api/route/:letter → tentors.org.uk to bypass CORS.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Route T: fetch real data and inject a test team row that advances every 30s.
// Test Team visits checkpoints progressively: one new tor every 30 real seconds.
app.get("/api/route/t", async (_req, res) => {
  // Non-via checkpoints on route T (matches routes.json waypoint labels).
  const checkpoints = [
    "PREWLEY MOOR", "KITTY TOR", "WILLSWORTHY", "WHITE BARROW",
    "HOLMING BEAM", "POSTBRIDGE", "KES TOR", "WATERN TOR", "OKEMENT HILL", "COSDON HILL",
  ];
  const tick = Math.floor(Date.now() / 30000);
  const reached = tick % (checkpoints.length + 1);
  const startH = 8, intervalMin = 30;
  const times = checkpoints.map((_, i) => {
    const total = startH * 60 + i * intervalMin;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  });
  const now = new Date();
  const nowStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  // Fetch real route T data (best-effort; fall back to test-only if upstream unavailable).
  let realHtml = "";
  try {
    const r = await fetch("https://tentors.org.uk/eventdata/routet.html", {
      headers: { "User-Agent": "tentors-tracker/0.1" },
    });
    if (r.ok) realHtml = await r.text();
  } catch { /* ignore */ }

  // Build test team row using the same column order as the real table headers (if available).
  // Find existing headers so column order matches.
  const headerMatch = realHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
  let testRow;
  if (headerMatch) {
    const hdrs = [...headerMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, "").trim().toUpperCase());
    const cells = hdrs.map((h, idx) => {
      if (idx === 0) return "Test Team";
      const ci = checkpoints.indexOf(h);
      return ci >= 0 && ci < reached ? times[ci] : "";
    });
    testRow = `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
  } else {
    // No real table — return standalone test HTML.
    const headers = ["Team", ...checkpoints];
    const cells = ["Test Team", ...checkpoints.map((_, i) => (i < reached ? times[i] : ""))];
    return res.type("text/html").send(`<!DOCTYPE html><html><body>
      <p>Last updated ${nowStr}</p>
      <table>
        <tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr>
        <tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>
      </table>
    </body></html>`);
  }

  // Inject test row before </table> and update "Last updated" timestamp.
  let html = realHtml.replace(/<\/table>/i, `${testRow}\n</table>`);
  html = html.replace(/Last updated[^<]*/i, `Last updated ${nowStr} (test injected)`);
  res.type("text/html").send(html);
});

async function proxyRoute(req, res) {
  const letter = (req.params.letter || "e").toLowerCase();
  if (!/^[a-z]$/.test(letter)) { res.status(400).send("Invalid route letter"); return; }
  try {
    const r = await fetch(`https://tentors.org.uk/eventdata/route${letter}.html`, {
      headers: { "User-Agent": "tentors-tracker/0.1" },
    });
    res.status(r.status).type("text/html").send(await r.text());
  } catch (e) {
    res.status(502).type("text/plain").send("Upstream fetch failed: " + e.message);
  }
}
app.get("/route:letter.html", proxyRoute);
app.get("/api/route:letter", proxyRoute);
app.get("/api/route/:letter", proxyRoute);

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(__dirname));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}/`));
