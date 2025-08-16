import { verifyAuth0 } from "../auth/auth0Verify.js";

export function requireAuth() {
  return async (req, res, next) => {
    try {
      const hdr = req.headers.authorization || "";
      const m = hdr.match(/^Bearer\s+(.+)$/i);
      if (!m) return res.status(401).json({ error: "Missing token" });

      const token = m[1].trim();
      req.user = await verifyAuth0(token);
      next();
    } catch (e) {
      console.error("Auth error:", e?.message || e);
      res.status(401).json({ error: "Invalid token" });
    }
  };
}
