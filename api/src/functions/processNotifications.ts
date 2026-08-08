// Queue-triggered processor for change notifications (docs/DESIGN.md §4.2).
// Validates clientState, decrypts the resource data, and — if the sender is a
// custodian a case is actively monitoring — appends the message and bumps the
// case's update counter (the bell). Invisible to end users.
import { app, InvocationContext } from '@azure/functions';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { decryptResourceData } from '../lib/notificationCrypto';
import { upsertMessage } from '../lib/ingest';

const SYSTEM_OID = '00000000-0000-0000-0000-000000000000';

async function processNotification(item: unknown, context: InvocationContext): Promise<void> {
  const notif: any = typeof item === 'string' ? JSON.parse(item) : item;

  // Lifecycle events (reauthorizationRequired / subscriptionRemoved) have no
  // resource data — the renewal timer handles reauthorization.
  if (!notif?.encryptedContent) return;

  // Validate clientState against a known subscription.
  if (notif.clientState) {
    const ok = await query(
      `SELECT 1 x FROM dbo.CollectionSubscription WHERE subscription_id=@sid AND client_state=@cs AND active=1`,
      { sid: notif.subscriptionId, cs: notif.clientState }
    );
    if (ok.recordset.length === 0) { context.warn('notification with unknown clientState/subscription; dropping'); return; }
  }

  let msg: any;
  try {
    msg = await decryptResourceData(notif.encryptedContent);
  } catch (e) {
    context.error(`decrypt failed: ${String(e)}`);
    throw e; // let the queue retry / dead-letter
  }

  const senderOid: string | null = msg?.from?.user?.id ?? null;
  if (!senderOid) return;

  // Which monitored cases care about this sender?
  const cases = await query<{ case_id: string }>(
    `SELECT case_id FROM dbo.CaseMonitoredUser WHERE user_oid=@oid`,
    { oid: senderOid }
  );
  if (cases.recordset.length === 0) return; // not a custodian we're collecting on

  for (const row of cases.recordset) {
    await upsertMessage(msg, { caseId: row.case_id, addedBy: SYSTEM_OID, markNew: true });
    await query(`UPDATE dbo.[Case] SET update_count = update_count + 1 WHERE case_id=@cid`, { cid: row.case_id });
    await audit(null, { action: 'AUTO_COLLECT', targetType: 'Case', targetId: row.case_id,
      detail: { messageId: msg.id, senderOid } });
  }
}

app.storageQueue('process-notifications', {
  queueName: 'notifications', connection: 'AzureWebJobsStorage', handler: processNotification,
});
