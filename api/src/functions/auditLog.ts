// Audit log view + export — PLATFORM ADMIN ONLY (docs/DESIGN.md §11).
// Exports to CSV or HTML with dates, times, names, and actions.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { isPlatformAdmin } from '../lib/rbac';

function guard(p: Principal): HttpResponseInit | null {
  return isPlatformAdmin(p) ? null : { status: 403, jsonBody: { error: 'Platform Admin required' } };
}

async function rows(from?: string, to?: string) {
  const where: string[] = ['1=1']; const params: Record<string, any> = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to');   params.to = to; }
  const r = await query(
    `SELECT occurred_at, actor_name, actor_upn, action, target_type, target_id, result
     FROM dbo.AuditEvent WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC`, params);
  return r.recordset as any[];
}

// GET /api/audit?from=&to=&format=json|csv|html
async function getAudit(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const denied = guard(p); if (denied) return denied;
  const from = req.query.get('from') || undefined;
  const to = req.query.get('to') || undefined;
  const format = (req.query.get('format') || 'json').toLowerCase();
  const data = await rows(from, to);

  if (format === 'csv') {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = 'Date,Time,Name,UPN,Action,TargetType,TargetId,Result';
    const body = data.map(r => {
      const d = new Date(r.occurred_at);
      return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 19),
        r.actor_name, r.actor_upn, r.action, r.target_type, r.target_id, r.result].map(esc).join(',');
    }).join('\n');
    return { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="cortex-audit.csv"' }, body: `${head}\n${body}` };
  }

  if (format === 'html') {
    const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    const trs = data.map(r => {
      const d = new Date(r.occurred_at);
      return `<tr><td>${d.toISOString().slice(0,10)}</td><td>${d.toISOString().slice(11,19)}</td>
        <td>${esc(r.actor_name)}</td><td>${esc(r.actor_upn)}</td><td>${esc(r.action)}</td>
        <td>${esc(r.target_type)}</td><td>${esc(r.target_id)}</td><td>${esc(r.result)}</td></tr>`;
    }).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>Cortex-PA audit log</title>
      <style>body{font-family:Segoe UI,Arial}table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #ccc;padding:4px 8px;font-size:13px}th{background:#eef1f6;text-align:left}</style>
      <h2>Cortex-PA — Audit Log</h2><p>Generated ${new Date().toISOString()} · ${data.length} events</p>
      <table><tr><th>Date</th><th>Time (UTC)</th><th>Name</th><th>UPN</th><th>Action</th><th>Target</th><th>Id</th><th>Result</th></tr>${trs}</table>`;
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
  }

  return { status: 200, jsonBody: data };
}

app.http('audit-log', { methods: ['GET'], authLevel: 'anonymous', route: 'audit', handler: requireAuth(getAudit) });
