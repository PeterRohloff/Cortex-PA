// Teams collection into a case (docs/DESIGN.md §4, §8.2, §8.3).
//   - Backfill a custodian's chat history via the Teams Export API.
//   - Enable continuous silent collection ONLY behind the legal-authorization
//     attestation, which is recorded to the audit log + subscription row; a
//     live Graph change-notification subscription is created and the custodian
//     is registered as a monitored user.
// Owner (or Platform Admin) only.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { assertCaseAccess, Forbidden } from '../lib/rbac';
import { findUser, getAllUserChatMessages } from '../lib/graph';
import { upsertMessage } from '../lib/ingest';
import { createSubscription } from '../lib/graphSubscriptions';

const ATTESTATION = "I confirm that the collection of this user's chats has been authorized by legal and is required for an investigation.";

interface CollectBody {
  userOid?: string;
  userTerm?: string;             // display name / email / upn / sam
  from?: string; to?: string;
  continueCollecting?: boolean;
  attestationAccepted?: boolean; // must be true to enable continuous collection
}

async function collect(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const caseId = req.params.id;
  try { await assertCaseAccess(p, caseId, 'own'); }
  catch (e) { if (e instanceof Forbidden) { await audit(p, { action: 'COLLECT', targetId: caseId, result: 'Denied' }); return { status: 403, jsonBody: { error: e.message } }; } throw e; }

  const b = (await req.json()) as CollectBody;

  // Resolve custodian.
  let userOid = b.userOid;
  if (!userOid && b.userTerm) {
    const users = await findUser(b.userTerm);
    if (!users.length) return { status: 404, jsonBody: { error: 'No matching user' } };
    userOid = users[0].id;
  }
  if (!userOid) return { status: 400, jsonBody: { error: 'userOid or userTerm required' } };

  // Continuous collection requires the legal attestation.
  let subscription: string | null = null;
  if (b.continueCollecting) {
    if (b.attestationAccepted !== true) {
      return { status: 400, jsonBody: { error: 'Legal-authorization attestation required', attestationText: ATTESTATION } };
    }
    await audit(p, { action: 'LEGAL_ATTESTATION', targetType: 'Case', targetId: caseId, detail: { userOid, attestation: ATTESTATION } });
    await query(`UPDATE dbo.[Case] SET continue_collecting=1 WHERE case_id=@cid`, { cid: caseId });

    // Register the custodian as monitored so the notification processor routes
    // their new messages to this case.
    await query(
      `MERGE dbo.CaseMonitoredUser AS t USING (SELECT @cid AS case_id, @oid AS user_oid) s
         ON t.case_id=s.case_id AND t.user_oid=s.user_oid
       WHEN NOT MATCHED THEN INSERT (case_id, user_oid, added_by_oid) VALUES (@cid, @oid, @by);`,
      { cid: caseId, oid: userOid, by: p.oid }
    );

    // Create (or reuse) a tenant-wide chat-message subscription with resource data.
    const existing = await query<{ subscription_id: string }>(
      `SELECT TOP 1 subscription_id FROM dbo.CollectionSubscription WHERE resource='/chats/getAllMessages' AND active=1`
    );
    if (existing.recordset.length === 0) {
      try {
        const sub = await createSubscription('/chats/getAllMessages');
        subscription = sub.id;
        await query(
          `INSERT INTO dbo.CollectionSubscription (subscription_id, case_id, resource, client_state, expires_at, authorized_by_oid, authorized_by_name)
           VALUES (@sid, @cid, '/chats/getAllMessages', @cs, @exp, @oid, @name)`,
          { sid: sub.id, cid: caseId, cs: sub.clientState, exp: sub.expirationDateTime, oid: p.oid, name: p.name ?? null }
        );
      } catch (e) {
        // Subscription needs the KV cert + public notify URL (runbook §8). Backfill
        // still proceeds; surface a warning rather than failing the request.
        await audit(p, { action: 'SUBSCRIPTION_CREATE', targetType: 'Case', targetId: caseId, result: 'Error', detail: { message: String(e) } });
      }
    } else {
      subscription = existing.recordset[0].subscription_id;
    }
  }

  // Backfill via the Teams Export API.
  let count = 0;
  for await (const page of getAllUserChatMessages(userOid, { from: b.from, to: b.to })) {
    for (const m of page) { await upsertMessage(m, { caseId, addedBy: p.oid }); count++; }
  }
  await query(`UPDATE dbo.[Case] SET update_count = update_count + @n WHERE case_id=@cid`, { n: count, cid: caseId });
  await audit(p, { action: 'COLLECT_BACKFILL', targetType: 'Case', targetId: caseId, detail: { userOid, count, from: b.from, to: b.to } });

  return { status: 200, jsonBody: { collected: count, continueCollecting: !!b.continueCollecting, subscription } };
}

app.http('collect-teams', {
  methods: ['POST'], authLevel: 'anonymous', route: 'cases/{id}/collect', handler: requireAuth(collect),
});
