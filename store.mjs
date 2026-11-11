import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

/** All local operations use one queue; transaction callbacks use their supplied tx. */
export async function openStore({databaseUrl, sqlitePath} = {}) {
  if (databaseUrl) {
    const {Pool} = await import('pg');
    const pool = new Pool({connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 15000});
    const run = async (client, sql, args = []) => {
      let index = 0;
      return client.query(sql.replace(/\?/g, () => '$' + (++index)), args);
    };
    return {
      query: (sql, args) => run(pool, sql, args),
      async transaction(callback) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // One restaurant's mutations share an owner, including request identity.
          await client.query('SELECT pg_advisory_xact_lock(782994611)');
          const result = await callback({query: (sql, args) => run(client, sql, args)});
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Production requires DATABASE_URL; local SQLite is never used for hosted bills.');
  if (!sqlitePath) throw new Error('Choose an explicit local development database path.');
  if (sqlitePath !== ':memory:') await mkdir(dirname(sqlitePath), {recursive: true});
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(sqlitePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  let tail = Promise.resolve();
  const enqueue = task => { const promise = tail.then(task); tail = promise.catch(() => {}); return promise; };
  const query = async (sql, args = []) => {
    const statement = db.prepare(sql);
    if (statement.columns().length) {
      const rows = statement.all(...args);
      return {rows, rowCount: rows.length};
    }
    const result = statement.run(...args);
    return {rows: [], rowCount: Number(result.changes)};
  };
  return {
    query: (sql, args) => enqueue(() => query(sql, args)),
    transaction: callback => enqueue(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await callback({query}); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    close: () => enqueue(() => db.close()),
  };
}
