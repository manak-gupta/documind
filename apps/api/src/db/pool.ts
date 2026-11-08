import pg from 'pg';

// The app depends on this narrow type, not on pg.Pool itself,
// so tests can pass a fake object with just a query() method.
export type Db = Pick<pg.Pool, 'query'>;

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,                        // Postgres connections are expensive; 10 is plenty for one API process
    idleTimeoutMillis: 30_000,      // release idle connections after 30 s
    connectionTimeoutMillis: 5_000, // fail fast instead of hanging if the DB is down
  });

  // If an idle connection drops (DB restart, network blip), pg emits 'error' on the pool.
  // Without a listener, Node treats it as an unhandled error and crashes the process.
  pool.on('error', (err) => {
    console.error('Postgres pool error (idle client):', err.message);
  });

  return pool;
}
