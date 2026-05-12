// Vercel serverless function: proxies tentors.org.uk route HTML (CORS workaround).
// Accepts /api/route/[letter] where letter is a-z.

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const letter = (req.query.letter || "e").toLowerCase();
  if (!/^[a-z]$/.test(letter)) {
    res.status(400).type("text/plain").send("Invalid route letter");
    return;
  }
  try {
    const r = await fetch(`https://tentors.org.uk/eventdata/route${letter}.html`, {
      headers: { "User-Agent": "tentors-tracker/0.1" },
    });
    const text = await r.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    res.status(r.status).send(text);
  } catch (err) {
    res.status(502).type("text/plain").send("Upstream fetch failed: " + err.message);
  }
}
