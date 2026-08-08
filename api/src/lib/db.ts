// Azure SQL connection using the Function's managed identity (no secrets,
// no SQL passwords). Acquires an Entra access token for the SQL resource
// and hands it to tedious. A single pooled connection is reused.

import * as sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

let poolPromise: Promise<sql.ConnectionPool> | null = null;
const credential = new DefaultAzureCredential();

export async function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    const token = await credential.getToken('https://database.windows.net/.default');
    const cfg: sql.config = {
      server: process.env.SQL_SERVER!,
      database: process.env.SQL_DATABASE!,
      options: { encrypt: true, trustServerCertificate: false },
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: token!.token },
      },
    };
    const pool = new sql.ConnectionPool(cfg);
    pool.on('error', () => { poolPromise = null; });
    return pool.connect();
  })();
  return poolPromise;
}

// Convenience: run a parameterized query.
export async function query<T = any>(
  text: string,
  params: Record<string, any> = {}
): Promise<sql.IResult<T>> {
  const pool = await getPool();
  const rq = pool.request();
  for (const [k, v] of Object.entries(params)) rq.input(k, v);
  return rq.query<T>(text);
}
