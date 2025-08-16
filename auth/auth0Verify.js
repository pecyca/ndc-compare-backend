import { createRemoteJWKSet, jwtVerify } from "jose";

const rawDomain = process.env.AUTH0_DOMAIN || "";
if (!rawDomain) throw new Error("Missing AUTH0_DOMAIN");
const issuer = rawDomain.startsWith("https://")
  ? `${rawDomain.replace(/\/+$/,"")}/`
  : `https://${rawDomain.replace(/\/+$/,"")}/`;

const audience = process.env.AUTH0_AUDIENCE;
if (!audience) throw new Error("Missing AUTH0_AUDIENCE");

const JWKS = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));

export async function verifyAuth0(token) {
  const { payload } = await jwtVerify(token, JWKS, { issuer, audience });
  if (payload?.email) payload.email = String(payload.email).toLowerCase();
  return payload;
}
