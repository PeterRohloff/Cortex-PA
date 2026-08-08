// MSAL configuration. Values are injected at build time from Vite env vars
// (see .env / deploy.sh). The SPA signs the user in against Entra ID and
// requests an access token for the API's exposed scope.

export const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_TENANT_ID}`,
    redirectUri: window.location.origin,
  },
  cache: { cacheLocation: 'sessionStorage' },
};

// Scope exposed by the API app registration, e.g. api://<api-client-id>/access_as_user
export const apiScopes = [import.meta.env.VITE_API_SCOPE];

export const API_BASE = import.meta.env.VITE_API_BASE; // https://<func>.azurewebsites.net/api
