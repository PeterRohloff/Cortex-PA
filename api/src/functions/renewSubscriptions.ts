// Timer-triggered renewal of Graph change-notification subscriptions
// (docs/DESIGN.md §4.2). Chat/channel message subscriptions are short-lived,
// so we extend any that expire within the next ~20 minutes.
import { app, InvocationContext, Timer } from '@azure/functions';
import { query } from '../lib/db';
import { renewSubscription } from '../lib/graphSubscriptions';

async function renew(_timer: Timer, context: InvocationContext): Promise<void> {
  const soon = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const due = await query<{ subscription_id: string }>(
    `SELECT subscription_id FROM dbo.CollectionSubscription
     WHERE active=1 AND (expires_at IS NULL OR expires_at < @soon)`,
    { soon }
  );
  for (const s of due.recordset) {
    try {
      const exp = await renewSubscription(s.subscription_id);
      await query(`UPDATE dbo.CollectionSubscription SET expires_at=@exp WHERE subscription_id=@sid`,
        { exp, sid: s.subscription_id });
    } catch (e) {
      context.error(`renew ${s.subscription_id} failed: ${String(e)}`);
      // If Graph reports the subscription is gone, mark inactive so collect can recreate it.
      await query(`UPDATE dbo.CollectionSubscription SET active=0 WHERE subscription_id=@sid`, { sid: s.subscription_id });
    }
  }
}

app.timer('renew-subscriptions', { schedule: '0 */15 * * * *', handler: renew });
