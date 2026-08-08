// Normalize + persist a Graph chatMessage into the store and (optionally)
// link it to a case. Shared by the backfill path (collectTeams) and the
// continuous change-notification processor (processNotifications).
import { createHash } from 'crypto';
import { query } from './db';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface IngestOpts {
  caseId?: string;
  addedBy: string;     // actor oid recorded on CaseMessage
  markNew?: boolean;   // set is_new_since_review = 1 (drives the bell)
}

export async function upsertMessage(m: any, opts: IngestOpts): Promise<void> {
  const convId: string = m.chatId || m.channelIdentity?.channelId || 'unknown';
  const source = m.channelIdentity ? 'Channel' : 'Group';
  await query(
    `MERGE dbo.Conversation AS t USING (SELECT @id AS conversation_id) s ON t.conversation_id=s.conversation_id
     WHEN NOT MATCHED THEN INSERT (conversation_id, source_type, channel_id) VALUES (@id, @src, @chan);`,
    { id: convId, src: source, chan: m.channelIdentity?.channelId ?? null }
  );

  const bodyContent: string = m.body?.content ?? '';
  await query(
    `MERGE dbo.Message AS t USING (SELECT @mid AS message_id) s ON t.message_id=s.message_id
     WHEN MATCHED THEN UPDATE SET body_text=@bt, last_edited_at=@edit, deleted_at=@del, content_sha256=@hash
     WHEN NOT MATCHED THEN INSERT (message_id, conversation_id, reply_to_id, from_oid, from_name,
        body_text, message_type, created_at, last_edited_at, deleted_at, content_sha256)
       VALUES (@mid, @conv, @reply, @foid, @fname, @bt, @mtype, @created, @edit, @del, @hash);`,
    {
      mid: m.id, conv: convId, reply: m.replyToId ?? null,
      foid: m.from?.user?.id ?? null, fname: m.from?.user?.displayName ?? null,
      bt: bodyContent, mtype: m.messageType ?? 'message',
      created: m.createdDateTime ?? null, edit: m.lastEditedDateTime ?? null,
      del: m.deletedDateTime ?? null, hash: sha(bodyContent),
    }
  );

  // Reactions (re-synced: clear then insert to reflect current state).
  await query(`DELETE FROM dbo.Reaction WHERE message_id=@mid`, { mid: m.id });
  for (const r of (m.reactions ?? [])) {
    await query(
      `INSERT INTO dbo.Reaction (message_id, reaction_type, actor_oid, created_at)
       VALUES (@mid, @rt, @actor, @at)`,
      { mid: m.id, rt: r.reactionType, actor: r.user?.user?.id ?? null, at: r.createdDateTime ?? null }
    );
  }

  if (opts.caseId) {
    await query(
      `MERGE dbo.CaseMessage AS t USING (SELECT @cid AS case_id, @mid AS message_id) s
         ON t.case_id=s.case_id AND t.message_id=s.message_id
       WHEN NOT MATCHED THEN INSERT (case_id, message_id, added_by_oid, is_new_since_review)
         VALUES (@cid, @mid, @by, @isnew);`,
      { cid: opts.caseId, mid: m.id, by: opts.addedBy, isnew: opts.markNew ? 1 : 0 }
    );
  }
}
