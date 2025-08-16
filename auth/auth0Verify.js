import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = `https://${process.env.AUTH0_DOMAIN}/`;   // e.g. dev-xxxx.us.auth0.com
const AUDIENCE = process.env.AUTH0_AUDIENCE;             // e.g. https://ndc-compare/api

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`));

export async function verifyAuth0(token) {
    const { payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        audience: AUDIENCE,
    });

    // Normalize common fields (works whether you added namespaced claims via an Action or not)
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

    const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];

    return { ...payload, email, name, permissions };
}
