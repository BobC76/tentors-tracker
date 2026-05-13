// Minimal static + proxy server.
// Serves the project root and proxies /api/route/:letter → tentors.org.uk to bypass CORS.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Route T: fetch real data and inject a "Test Team" row that advances one checkpoint every 30s.
// ALL waypoints appear as columns in the real results table (vias included, labelled "X (via)").
// Times cycle through a realistic two-day scenario (Sat start → overnight → Sun finish).
app.get("/api/route/t", async (_req, res) => {
  // All route T checkpoints in order, via-suffix stripped to match normalizeWp() in tracker.
  const checkpoints = [
    "PREWLEY MOOR", "KITTY TOR", "NODDEN GATE",
    "WILLSWORTHY", "WHITE BARROW", "LITTLE MIS TOR",
    "HOLMING BEAM", "ROUGH TOR", "POSTBRIDGE",
    "WATER HILL", "KES TOR", "FERNWORTHY",
    "WATERN TOR", "OKEMENT HILL", "SHILSTONE TOR",
    "COSDON HILL", "HIGHER TOR",
  ];
  // Realistic times across both days (overnight rollover after WATER HILL triggers day-2 logic).
  const allTimes = [
    "08:00", "09:30", "10:50",   // Sat: PREWLEY MOOR, KITTY TOR, NODDEN GATE
    "12:00", "13:30", "15:00",   // Sat: WILLSWORTHY, WHITE BARROW, LITTLE MIS TOR
    "16:30", "18:00", "19:30",   // Sat: HOLMING BEAM, ROUGH TOR, POSTBRIDGE
    "21:00",                     // Sat overnight: WATER HILL  (rollover detected after this)
    "06:30", "07:30",            // Sun: KES TOR, FERNWORTHY
    "08:30", "10:00", "11:30",   // Sun: WATERN TOR, OKEMENT HILL, SHILSTONE TOR
    "13:00", "14:30",            // Sun: COSDON HILL, HIGHER TOR
  ];

  const tick = Math.floor(Date.now() / 30000);
  const reached = tick % (checkpoints.length + 1); // 0 = not started, cycles through all states
  const now = new Date();
  const nowStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // Fetch real route T data (best-effort).
  let realHtml = "";
  try {
    const r = await fetch("https://tentors.org.uk/eventdata/routet.html", {
      headers: { "User-Agent": "tentors-tracker/0.1" },
    });
    if (r.ok) realHtml = await r.text();
  } catch { /* ignore */ }

  if (!realHtml) {
    // Fallback: standalone test-only HTML when upstream is unreachable.
    const headers = ["Team", "CODE", "START", ...checkpoints, "FINISH"];
    const cells = [
      "Test Team", "TT", "07:00",
      ...checkpoints.map((_, i) => (i < reached ? allTimes[i] : "")),
      reached >= checkpoints.length ? "16:00" : "",
    ];
    return res.type("text/html").send(`<!DOCTYPE html><html><body>
      <p>LAST UPDATED: ${nowStr}</p>
      <table>
        <tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr>
        <tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>
      </table>
    </body></html>`);
  }

  // Parse the real table's header row to build a cell array matching the exact column order.
  const headerMatch = realHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
  if (headerMatch) {
    const hdrs = [...headerMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toUpperCase());

    const cells = hdrs.map((h, idx) => {
      if (idx === 0) return "Test Team";
      if (h === "CODE") return "TT";
      if (h === "START") return "07:00";
      if (h === "FINISH") return reached >= checkpoints.length ? "16:00" : "";
      // Strip "(VIA)" suffix to match against normalised checkpoint names.
      const normalized = h.replace(/\s*\(VIA\)\s*$/, "").trim();
      const ci = checkpoints.indexOf(normalized);
      return ci >= 0 && ci < reached ? allTimes[ci] : "";
    });

    const testRow = `<tr>${cells.map(c => `<td align="center">${c}</td>`).join("")}</tr>`;
    let html = realHtml.replace(/(<\/table>)/i, `${testRow}\n$1`);
    // Update the "LAST UPDATED" time in the header cell.
    html = html.replace(/(LAST UPDATED:\s*)\d{1,2}:\d{2}/i, `$1${nowStr} [+test]`);
    return res.type("text/html").send(html);
  }

  res.type("text/html").send(realHtml);
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
app.get("/route/:letter.html", proxyRoute);
app.get("/api/route/:letter", proxyRoute);

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(__dirname));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}/`));
