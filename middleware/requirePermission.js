// middleware/requirePermission.js
// Checks that the decoded token (req.user) includes the required Auth0 permission.
// Optionally, when allowApprovedFallback=true, users with DB flag isApprovedCommenter can also pass for 'comment:write'.

export function requirePermission(required, allowApprovedFallback = false, db = null) {
    return async (req, res, next) => {
        try {
            const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];

            // RBAC direct match
            if (perms.includes(required)) {
                return next();
            }

            // Optional fallback for legacy approved commenters (only makes sense for comment:write)
            if (allowApprovedFallback && required === 'comment:write' && db) {
                const email = (req.user?.email || '').toLowerCase();
                const row = await db.get('SELECT isApprovedCommenter FROM users WHERE email=?', [email]);
                if (row?.isApprovedCommenter === 1) {
                    return next();
                }
            }

            return res.status(403).json({ error: 'Insufficient permissions', required });
        } catch (e) {
            console.error('requirePermission error:', e);
            return res.status(500).json({ error: 'Internal error' });
        }
    };
}
