// Create / renew Microsoft Graph change-notification subscriptions for
// continuous silent collection (docs/DESIGN.md §4.2). Subscriptions request
// resource data encrypted to the Key Vault certificate's public key.
import { randomUUID } from 'crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { CertificateClient } from '@azure/keyvault-certificates';
import { getGraphToken, GRAPH_BASE } from './graph';

const credential = new DefaultAzureCredential();
const KV = process.env.KEY_VAULT_NAME!;
const CERT_NAME = process.env.NOTIFICATION_CERT_NAME || 'cortex-notify';
const NOTIFY_BASE = process.env.NOTIFICATION_BASE_URL!; // https://<func>.azurewebsites.net
const certClient = new CertificateClient(`https://${KV}.vault.azure.net`, credential);

// Base64 DER public cert that Graph uses to encrypt resource data.
async function encryptionCertificate(): Promise<{ cer: string; id: string }> {
  const cert = await certClient.getCertificate(CERT_NAME);
  return { cer: Buffer.from(cert.cer!).toString('base64'), id: CERT_NAME };
}

async function graphFetch(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${await getGraphToken()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Graph ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

export interface CreatedSubscription { id: string; clientState: string; expirationDateTime: string; }

export async function createSubscription(resource: string): Promise<CreatedSubscription> {
  const { cer, id } = await encryptionCertificate();
  const clientState = randomUUID();
  const url = `${NOTIFY_BASE}/api/notifications`;
  const sub = await graphFetch('POST', '/subscriptions', {
    changeType: 'created,updated',
    notificationUrl: url,
    lifecycleNotificationUrl: url,
    resource,
    includeResourceData: true,
    encryptionCertificate: cer,
    encryptionCertificateId: id,
    clientState,
    // Chat/channel message subscriptions are short-lived; renew on a timer.
    expirationDateTime: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  });
  return { id: sub.id, clientState, expirationDateTime: sub.expirationDateTime };
}

export async function renewSubscription(id: string): Promise<string> {
  const sub = await graphFetch('PATCH', `/subscriptions/${id}`, {
    expirationDateTime: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  });
  return sub.expirationDateTime;
}

export async function deleteSubscription(id: string): Promise<void> {
  await graphFetch('DELETE', `/subscriptions/${id}`);
}
