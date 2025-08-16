// middleware/requirePermission.js
// Checks that the decoded token (req.user) includes the required Auth0 permission.
// Optionally, when allowApprovedFallback=true AND required==='comment:write',
// users with DB flag isApprovedCommenter can also pass (requires passing `db`).

export function requirePermission(required, allowApprovedFallback = false, db = null) {
    return async (req, res, next) => {
        try {
            const tokenPerms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
            const needed = Array.isArray(required) ? required : [required];

            // Direct RBAC check (must include ALL required permissions)
            const hasAll = needed.every((p) => tokenPerms.includes(p));
            if (hasAll) return next();

            // Optional legacy fallback for write-only
            if (
                allowApprovedFallback &&
                db &&
                needed.length === 1 &&
                needed[0] === 'comment:write'
            ) {
                const email = (req.user?.email || '').toLowerCase();
                if (email) {
                    try {
                        const row = await db.get(
                            'SELECT isApprovedCommenter FROM users WHERE email = ?',
                            [email]
                        );
                        if (row?.isApprovedCommenter === 1) {
                            return next();
                        }
                    } catch (dbErr) {
                        console.error('requirePermission DB check failed:', dbErr);
                        // fall through to 403 below
                    }
                }
            }

            return res.status(403).json({
                error: 'insufficient_permissions',
                required: needed,
                have: tokenPerms,
            });
        } catch (e) {
            console.error('requirePermission error:', e);
            return res.status(500).json({ error: 'Internal error' });
        }
    };
}
