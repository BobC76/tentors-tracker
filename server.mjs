// Minimal static + proxy server.
// Serves the project root and proxies /api/route/:letter → tentors.org.uk to bypass CORS.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

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
