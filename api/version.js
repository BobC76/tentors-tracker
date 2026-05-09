// Returns the current deploy version. Used by the client for auto-reload
// when the deployed code changes.

export const config = { runtime: "nodejs" };

export default function handler(_req, res) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ sha });
}
