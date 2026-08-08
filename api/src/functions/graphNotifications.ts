// Change-notification receiver for continuous silent collection
// (docs/DESIGN.md §4.2). Handles Graph's validation handshake and accepts
// encrypted notifications. Decryption uses the RSA private key held in Key
// Vault; the decrypt + persist step is stubbed and marked for completion.
//
// This endpoint is intentionally unauthenticated (Graph calls it) but:
//   - it only ACKs the validation token or enqueues encrypted payloads;
//   - it must be reachable by Graph, so in the hardened topology it sits
//     behind a private-ingress-with-controlled-egress or a dedicated
//     notification endpoint. See runbook §7.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';

async function notifications(req: HttpRequest): Promise<HttpResponseInit> {
  // 1) Subscription validation handshake.
  const validationToken = req.query.get('validationToken');
  if (validationToken) {
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: validationToken };
  }

  // 2) Notification batch (each item carries encryptedContent for resource-data subs).
  const body = (await req.json().catch(() => ({}))) as any;
  const items: any[] = body?.value ?? [];

  // TODO(next): for each item —
  //   a) validate item.encryptedContent.dataSignature (HMAC-SHA256)
  //   b) RSA-decrypt the symmetric key with the KV private key
  //   c) AES-CBC decrypt encryptedContent.data -> chatMessage JSON
  //   d) look up which case(s) the sender/custodian belongs to
  //   e) upsert the message, increment Case.update_count + mark is_new_since_review
  // Persist to a queue here and process out-of-band to ACK Graph within 3s.
  // eslint-disable-next-line no-console
  console.log(`received ${items.length} change notification(s)`);

  return { status: 202 };
}

app.http('graph-notifications', {
  methods: ['POST'], authLevel: 'anonymous', route: 'notifications', handler: notifications,
});
