export function requirePermission(perm) {
  return (req, res, next) => {
    const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (perms.includes(perm)) return next();
    return res.status(403).json({ error: 'insufficient_permissions', missing: perm });
  };
}
