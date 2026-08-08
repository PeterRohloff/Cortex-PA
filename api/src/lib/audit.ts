// Append-only audit logging (docs/DESIGN.md §11). Every meaningful action
// records actor + action + target into the append-only LEDGER table.
// Never throws into the caller path — audit failures are logged, not fatal.

import { Principal } from './auth';
import { query } from './db';

export interface AuditInput {
  action: string;                 // LOGIN, SEARCH, VIEW_CONVERSATION, CREATE_CASE, ADD_CHAT, EXPORT, ...
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  result?: 'Success' | 'Denied' | 'Error';
}

export async function audit(p: Principal | null, e: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO dbo.AuditEvent (actor_oid, actor_name, actor_upn, action, target_type, target_id, detail_json, result)
       VALUES (@oid, @name, @upn, @action, @tt, @tid, @detail, @result)`,
      {
        oid: p?.oid ?? null,
        name: p?.name ?? null,
        upn: p?.upn ?? null,
        action: e.action,
        tt: e.targetType ?? null,
        tid: e.targetId ?? null,
        detail: e.detail ? JSON.stringify(e.detail) : null,
        result: e.result ?? 'Success',
      }
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('audit write failed', err);
  }
}
