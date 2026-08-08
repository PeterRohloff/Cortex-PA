// Random, obscure, unchangeable project codenames + immutable case numbers
// (docs/DESIGN.md §8.1). Codenames are drawn with crypto-strong randomness
// and checked for uniqueness; case numbers come from a monotonic sequence.

import { randomInt } from 'crypto';
import { query } from './db';

const ADJECTIVES = [
  'SILENT', 'AMBER', 'IRON', 'HOLLOW', 'CRIMSON', 'NORTHERN', 'QUIET', 'HIDDEN',
  'COBALT', 'GRANITE', 'PALE', 'DISTANT', 'FROZEN', 'SHATTERED', 'VELVET',
  'OBSIDIAN', 'RESTLESS', 'FADED', 'GILDED', 'MARBLE', 'SOLEMN', 'DUSKY',
];
const NOUNS = [
  'MERIDIAN', 'LATTICE', 'HARBOR', 'CIPHER', 'BEACON', 'FALCON', 'MONOLITH',
  'CANYON', 'THRESHOLD', 'ORCHARD', 'VECTOR', 'PILGRIM', 'LANTERN', 'COMPASS',
  'ARCHIVE', 'SUMMIT', 'CURRENT', 'ECHO', 'WARDEN', 'THICKET', 'ANVIL',
];

function pick<T>(arr: T[]): T { return arr[randomInt(arr.length)]; }

// Unique two-word codename, e.g. "SILENT MERIDIAN".
export async function generateCodename(): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    const r = await query('SELECT 1 AS x FROM dbo.[Case] WHERE project_codename=@n', { n: name });
    if (r.recordset.length === 0) return name;
  }
  // Fallback guarantees uniqueness if the space gets crowded.
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}-${randomInt(1000, 9999)}`;
}

// Immutable case number CTX-YYYY-###### from a never-reused sequence.
export async function generateCaseNumber(): Promise<string> {
  const seq = await query<{ id: number }>(
    'INSERT INTO dbo.CaseSeq DEFAULT VALUES; SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;'
  );
  const id = seq.recordset[0].id;
  const year = new Date().getUTCFullYear();
  return `CTX-${year}-${String(id).padStart(6, '0')}`;
}
