// middleware/requireAuth.js
import { verifyAuth0 } from "../auth/auth0Verify.js";

export function requireAuth() {
    return async (req, res, next) => {
        try {
            const hdr = req.headers.authorization || "";
            const m = hdr.match(/^Bearer\s+(.+)$/i);
            if (!m) return res.status(401).json({ error: "Missing token" });

            const token = m[1].trim();

            // Verify & get the raw JWT payload
            const payload = await verifyAuth0(token);

            // Normalize email & name from possible locations
            const email =
                (payload?.email ||
                    payload?.["https://ndc-compare/email"] ||
                    payload?.["https://ndc_compare/email"] || // tolerate underscore if you ever used it
                    ""
                ).toLowerCase();

            const name =
                payload?.name ||
                payload?.nickname ||
                payload?.["https://ndc-compare/name"] ||
                email ||
                "";

            // What downstream code expects:
            req.user = {
                sub: payload?.sub || "",
                email,
                name,
                // keep raw if you ever need more claims:
                claims: payload,
            };

            return next();
        } catch (e) {
            console.error("Auth error:", e?.message || e);
            return res.status(401).json({ error: "Invalid token" });
        }
    };
}
