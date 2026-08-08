// Authorization helpers implementing the RBAC model in docs/DESIGN.md §9.
//
// Platform roles (Entra app roles on the token):
//   Platform.Admin  -> sees & does everything, in every case
//   Case.Creator    -> may create cases; still sees only own/permitted cases
// Per-case roles (rows in dbo.CaseMember): Owner | Member.

import { Principal } from './auth';
import { query } from './db';

export const isPlatformAdmin = (p: Principal) => p.roles.includes('Platform.Admin');
export const isCaseCreator   = (p: Principal) => p.roles.includes('Case.Creator') || isPlatformAdmin(p);

export type CaseRole = 'Owner' | 'Member' | null;

// The caller's role on a specific case. Platform admins are treated as Owner.
export async function caseRole(p: Principal, caseId: string): Promise<CaseRole> {
  if (isPlatformAdmin(p)) return 'Owner';
  const r = await query<{ role: CaseRole }>(
    'SELECT role FROM dbo.CaseMember WHERE case_id=@cid AND member_oid=@oid',
    { cid: caseId, oid: p.oid }
  );
  return r.recordset[0]?.role ?? null;
}

// Throws { status } if the caller may not access the case at the required level.
export class Forbidden extends Error { status = 403; }

export async function assertCaseAccess(
  p: Principal,
  caseId: string,
  need: 'view' | 'own' = 'view'
): Promise<CaseRole> {
  const role = await caseRole(p, caseId);
  if (!role) throw new Forbidden('No access to this case');
  if (need === 'own' && role !== 'Owner') throw new Forbidden('Owner role required');
  return role;
}

// SQL fragment + params that limit a query to cases the caller may see.
// Platform admins get an always-true predicate.
export function caseVisibilityFilter(p: Principal, alias = 'c'): { sql: string; oid: string } {
  if (isPlatformAdmin(p)) return { sql: '1=1', oid: p.oid };
  return {
    sql: `${alias}.case_id IN (SELECT case_id FROM dbo.CaseMember WHERE member_oid=@void)`,
    oid: p.oid,
  };
}
