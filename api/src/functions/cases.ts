// Case lifecycle + membership (docs/DESIGN.md §8, §9).
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { generateCodename, generateCaseNumber } from '../lib/codename';
import {
  isCaseCreator, isPlatformAdmin, caseVisibilityFilter, assertCaseAccess, Forbidden,
} from '../lib/rbac';

const json = (status: number, body: unknown): HttpResponseInit => ({ status, jsonBody: body });

// GET /api/cases — only cases the caller may see (all, if Platform Admin).
async function listCases(p: Principal): Promise<HttpResponseInit> {
  const f = caseVisibilityFilter(p, 'c');
  const r = await query(
    `SELECT c.case_id, c.case_number, c.project_codename, c.status,
            c.continue_collecting, c.update_count, c.created_at
     FROM dbo.[Case] c WHERE ${f.sql} ORDER BY c.created_at DESC`,
    { void: f.oid }
  );
  await audit(p, { action: 'LIST_CASES' });
  return json(200, r.recordset);
}

// POST /api/cases — create a case (requires Case.Creator or Platform.Admin).
async function createCase(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  if (!isCaseCreator(p)) { await audit(p, { action: 'CREATE_CASE', result: 'Denied' }); return json(403, { error: 'Case.Creator role required' }); }
  const b = (await req.json()) as any;
  const codename = await generateCodename();
  const caseNumber = await generateCaseNumber();
  const ins = await query<{ case_id: string }>(
    `INSERT INTO dbo.[Case] (case_number, project_codename, description_html, created_by_oid, created_by_name)
     OUTPUT INSERTED.case_id
     VALUES (@num, @code, @desc, @oid, @name)`,
    { num: caseNumber, code: codename, desc: sanitize(b.descriptionHtml), oid: p.oid, name: p.name ?? null }
  );
  const caseId = ins.recordset[0].case_id;
  // Creator becomes the first Owner.
  await query(
    `INSERT INTO dbo.CaseMember (case_id, member_oid, member_name, role, granted_by_oid)
     VALUES (@cid, @oid, @name, 'Owner', @oid)`,
    { cid: caseId, oid: p.oid, name: p.name ?? null }
  );
  // Custodians / non-custodians (free text).
  for (const c of (b.custodians ?? []) as any[]) {
    await query(
      `INSERT INTO dbo.Custodian (case_id, name, email, kind) VALUES (@cid, @n, @e, @k)`,
      { cid: caseId, n: c.name, e: c.email ?? null, k: c.kind === 'NonCustodian' ? 'NonCustodian' : 'Custodian' }
    );
  }
  await audit(p, { action: 'CREATE_CASE', targetType: 'Case', targetId: caseId, detail: { caseNumber, codename } });
  return json(201, { caseId, caseNumber, projectCodename: codename });
}

// GET /api/cases/{id}
async function getCase(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const caseId = req.params.id;
  try { await assertCaseAccess(p, caseId, 'view'); }
  catch (e) { if (e instanceof Forbidden) return json(403, { error: e.message }); throw e; }
  const c = await query(`SELECT * FROM dbo.[Case] WHERE case_id=@cid`, { cid: caseId });
  const cust = await query(`SELECT name, email, kind FROM dbo.Custodian WHERE case_id=@cid`, { cid: caseId });
  const mem = await query(`SELECT member_oid, member_name, role FROM dbo.CaseMember WHERE case_id=@cid`, { cid: caseId });
  await audit(p, { action: 'VIEW_CASE', targetType: 'Case', targetId: caseId });
  return json(200, { case: c.recordset[0], custodians: cust.recordset, members: mem.recordset });
}

// PATCH /api/cases/{id} — archive / continue-collecting toggle (Owner or Admin).
async function updateCase(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const caseId = req.params.id;
  try { await assertCaseAccess(p, caseId, 'own'); }
  catch (e) { if (e instanceof Forbidden) return json(403, { error: e.message }); throw e; }
  const b = (await req.json()) as any;
  if (b.status && ['Active', 'Archived'].includes(b.status)) {
    await query(`UPDATE dbo.[Case] SET status=@s WHERE case_id=@cid`, { s: b.status, cid: caseId });
    await audit(p, { action: b.status === 'Archived' ? 'ARCHIVE_CASE' : 'UNARCHIVE_CASE', targetType: 'Case', targetId: caseId });
  }
  // NOTE: enabling continue_collecting is handled by collectTeams.ts, which
  // enforces the legal-authorization attestation (design §8.3).
  return json(200, { ok: true });
}

// POST /api/cases/{id}/members — add an org user as Owner|Member (Owner/Admin).
async function addMember(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const caseId = req.params.id;
  try { await assertCaseAccess(p, caseId, 'own'); }
  catch (e) { if (e instanceof Forbidden) return json(403, { error: e.message }); throw e; }
  const b = (await req.json()) as any;
  const role = b.role === 'Owner' ? 'Owner' : 'Member';
  await query(
    `MERGE dbo.CaseMember AS t
     USING (SELECT @cid AS case_id, @oid AS member_oid) AS s
     ON t.case_id=s.case_id AND t.member_oid=s.member_oid
     WHEN MATCHED THEN UPDATE SET role=@role, member_name=@name
     WHEN NOT MATCHED THEN INSERT (case_id, member_oid, member_name, role, granted_by_oid)
       VALUES (@cid, @oid, @name, @role, @by);`,
    { cid: caseId, oid: b.memberOid, name: b.memberName ?? null, role, by: p.oid }
  );
  await audit(p, { action: 'ADD_MEMBER', targetType: 'Case', targetId: caseId, detail: { memberOid: b.memberOid, role } });
  return json(200, { ok: true });
}

// Minimal server-side HTML sanitizer for the rich-text description.
// Strips scripts, event handlers, and javascript: URLs. Replace with a
// vetted library (e.g. DOMPurify/sanitize-html) before production.
function sanitize(html: unknown): string | null {
  if (typeof html !== 'string') return null;
  return html
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/ on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

app.http('cases-list',   { methods: ['GET'],  authLevel: 'anonymous', route: 'cases',              handler: requireAuth(listCases) });
app.http('cases-create', { methods: ['POST'], authLevel: 'anonymous', route: 'cases',              handler: requireAuth(createCase) });
app.http('cases-get',    { methods: ['GET'],  authLevel: 'anonymous', route: 'cases/{id}',         handler: requireAuth(getCase) });
app.http('cases-update', { methods: ['PATCH'],authLevel: 'anonymous', route: 'cases/{id}',         handler: requireAuth(updateCase) });
app.http('cases-member', { methods: ['POST'], authLevel: 'anonymous', route: 'cases/{id}/members', handler: requireAuth(addMember) });
