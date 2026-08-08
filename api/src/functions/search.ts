// Search collected chats (docs/DESIGN.md §6). Default: any conversation
// containing the searched user(s). Optional filters: participants (AND/OR),
// date range, team, channel, topic substring, attachment, reaction.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { isPlatformAdmin } from '../lib/rbac';

interface SearchBody {
  caseId?: string;               // when set, confine search to this case (Members)
  people?: string[];            // display name / email / upn / sam — resolved to oids client-side or here
  peopleOids?: string[];        // resolved Entra object ids
  matchAll?: boolean;           // true => conversations containing ALL; default any
  from?: string; to?: string;   // ISO date range
  teamName?: string; channelName?: string;
  topic?: string;               // substring in message body
  hasAttachment?: boolean;
  reactionType?: string;
}

async function search(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const b = (await req.json()) as SearchBody;
  const params: Record<string, any> = {};
  const where: string[] = ['1=1'];

  // Confine to a case (and enforce access) when caseId supplied.
  if (b.caseId) {
    if (!isPlatformAdmin(p)) {
      const acc = await query(`SELECT 1 x FROM dbo.CaseMember WHERE case_id=@cid AND member_oid=@oid`,
        { cid: b.caseId, oid: p.oid });
      if (acc.recordset.length === 0) return { status: 403, jsonBody: { error: 'No access to this case' } };
    }
    where.push(`m.message_id IN (SELECT message_id FROM dbo.CaseMessage WHERE case_id=@caseId)`);
    params.caseId = b.caseId;
  }

  // People: conversations where the searched user is a participant/sender.
  const oids = b.peopleOids ?? [];
  if (oids.length) {
    const list = oids.map((_, i) => `@oid${i}`).join(',');
    oids.forEach((o, i) => (params[`oid${i}`] = o));
    if (b.matchAll && oids.length > 1) {
      // conversations containing ALL named participants
      where.push(`m.conversation_id IN (
        SELECT conversation_id FROM dbo.Message WHERE from_oid IN (${list})
        GROUP BY conversation_id HAVING COUNT(DISTINCT from_oid) = ${oids.length})`);
    } else {
      // default: any conversation containing any searched user
      where.push(`m.conversation_id IN (SELECT conversation_id FROM dbo.Message WHERE from_oid IN (${list}))`);
    }
  }

  if (b.from) { where.push('m.created_at >= @from'); params.from = b.from; }
  if (b.to)   { where.push('m.created_at <= @to');   params.to = b.to; }
  if (b.teamName)    { where.push('conv.team_name LIKE @team');       params.team = `%${b.teamName}%`; }
  if (b.channelName) { where.push('conv.channel_name LIKE @channel'); params.channel = `%${b.channelName}%`; }
  if (b.topic)       { where.push('m.body_text LIKE @topic');         params.topic = `%${b.topic}%`; }
  if (b.hasAttachment) where.push('EXISTS (SELECT 1 FROM dbo.Attachment a WHERE a.message_id=m.message_id)');
  if (b.reactionType) {
    where.push('EXISTS (SELECT 1 FROM dbo.Reaction r WHERE r.message_id=m.message_id AND r.reaction_type=@rx)');
    params.rx = b.reactionType;
  }

  // Group hits by conversation with a preview.
  const sql = `
    SELECT TOP 200 conv.conversation_id, conv.source_type, conv.team_name, conv.channel_name, conv.topic,
           COUNT(m.message_id) AS hit_count,
           MIN(m.created_at) AS first_hit, MAX(m.created_at) AS last_hit
    FROM dbo.Message m
    JOIN dbo.Conversation conv ON conv.conversation_id = m.conversation_id
    WHERE ${where.join(' AND ')}
    GROUP BY conv.conversation_id, conv.source_type, conv.team_name, conv.channel_name, conv.topic
    ORDER BY last_hit DESC`;
  const r = await query(sql, params);
  await audit(p, { action: 'SEARCH', targetType: b.caseId ? 'Case' : 'Global', targetId: b.caseId, detail: b as any });
  return { status: 200, jsonBody: r.recordset };
}

app.http('search', { methods: ['POST'], authLevel: 'anonymous', route: 'search', handler: requireAuth(search) });
