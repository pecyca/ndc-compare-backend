// middleware/requireAuth.js
import { verifyAuth0 } from "../auth/auth0Verify.js";

export function requireAuth() {
    return async (req, res, next) => {
        try {
            const hdr = req.headers.authorization || "";
            const m = hdr.match(/^Bearer\s+(.+)$/i);
            if (!m) return res.status(401).json({ error: "Missing token" });

            const token = m[1].trim();

            // Verify & get the raw JWT payload (already normalized by verifyAuth0)
            const payload = await verifyAuth0(token);

            // Normalize email & name from possible locations (extra tolerance)
            const email = (
                payload?.email ||
                payload?.["https://ndc-compare/email"] ||
                payload?.["https://ndc_compare/email"] ||
                ""
            ).toLowerCase();

            const name =
                payload?.name ||
                payload?.nickname ||
                payload?.["https://ndc-compare/name"] ||
                email ||
                "";

            // Pull permissions from payload (Auth0 RBAC: "Add Permissions in the Access Token")
            const permissions = Array.isArray(payload?.permissions) ? payload.permissions : [];

            // What downstream code expects:
            req.user = {
                sub: payload?.sub || "",
                email,
                name,
                permissions,   // <-- pass-through so requirePermission & /me can read it
                claims: payload, // keep all raw claims for debugging or edge reads
            };

            return next();
        } catch (e) {
            console.error("Auth error:", e?.message || e);
            return res.status(401).json({ error: "Invalid token" });
        }
    };
}
