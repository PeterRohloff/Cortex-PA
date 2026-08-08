// Entra ID token validation for the API.
// The SPA acquires an access token for this API's scope via MSAL; every
// request is verified here (signature, issuer, audience) and the caller's
// identity + app roles are extracted. No token => 401.

import { HttpRequest } from '@azure/functions';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

const TENANT = process.env.TENANT_ID!;
const AUDIENCE = process.env.API_APP_CLIENT_ID!;
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const jwks = new JwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
  cache: true,
  rateLimit: true,
});

export interface Principal {
  oid: string;
  name?: string;
  upn?: string;
  roles: string[]; // Entra app roles: 'Platform.Admin', 'Case.Creator', ...
}

export class AuthError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

function getKey(header: jwt.JwtHeader, cb: jwt.SigningKeyCallback) {
  jwks.getSigningKey(header.kid!, (err, key) => {
    if (err) return cb(err);
    cb(null, key!.getPublicKey());
  });
}

export function authenticate(req: HttpRequest): Promise<Principal> {
  const header = req.headers.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
  if (!token) return Promise.reject(new AuthError(401, 'Missing bearer token'));

  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      // Accept both the api://<clientId> and <clientId> audience forms.
      { audience: [AUDIENCE, `api://${AUDIENCE}`], issuer: ISSUER, algorithms: ['RS256'] },
      (err, decoded) => {
        if (err) return reject(new AuthError(401, `Invalid token: ${err.message}`));
        const c = decoded as jwt.JwtPayload;
        resolve({
          oid: (c.oid || c.sub) as string,
          name: c.name as string | undefined,
          upn: (c.preferred_username || c.upn) as string | undefined,
          roles: (c.roles as string[] | undefined) ?? [],
        });
      }
    );
  });
}

// Wraps an authenticated handler; returns 401/403 JSON on auth failure.
export function requireAuth<T>(
  handler: (p: Principal, req: HttpRequest) => Promise<T>
) {
  return async (req: HttpRequest) => {
    try {
      const principal = await authenticate(req);
      return await handler(principal, req);
    } catch (e) {
      if (e instanceof AuthError) {
        return { status: e.status, jsonBody: { error: e.message } };
      }
      throw e;
    }
  };
}
