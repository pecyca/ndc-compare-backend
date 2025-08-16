// auth/auth0Verify.js
import { createRemoteJWKSet, jwtVerify } from 'jose';

// --- Required env ---
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;    // e.g. dev-xxxx.us.auth0.com (NO protocol)
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;  // e.g. https://ndc-compare/api

if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE) {
    throw new Error(
        '[auth0Verify] Missing AUTH0_DOMAIN and/or AUTH0_AUDIENCE in server environment.'
    );
}

// Build issuer & JWKS URL
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`));

/**
 * Verify an Auth0 access token and return a normalized payload.
 * - Keeps the full payload (including `permissions`) so RBAC works.
 * - Adds `email`, `name`, and `permissions` convenience fields.
 */
export async function verifyAuth0(token) {
    if (!token || typeof token !== 'string') {
        throw new Error('[auth0Verify] No token provided');
    }

    // Verify JWT (RS256) against Auth0 issuer & audience; allow small clock skew.
    const { payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        audience: AUTH0_AUDIENCE,
        algorithms: ['RS256'],
        clockTolerance: 60, // seconds
    });

    // Normalize common fields (support plain and namespaced custom claims)
    const email =
        payload.email ||
        payload['https://ndc-compare/email'] ||
        payload['https://ndccompare/email'] ||
        '';

    const name =
        payload.name ||
        payload['https://ndc-compare/name'] ||
        payload.nickname ||
        email ||
        '';

    // Auth0 adds permissions top-level when RBAC + "Add permissions to access token" are enabled.
    const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];

    // Return everything (so downstream can read any claim) plus normalized fields.
    return {
        ...payload,
        email,
        name,
        permissions,
    };
}
