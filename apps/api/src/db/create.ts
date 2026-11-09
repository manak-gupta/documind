import pg from 'pg';

// Creates the database named in `url` if it doesn't exist yet, by connecting to the default
// "postgres" database first. Used by tests, end-to-end tests and demo mode.
export async function createDatabaseIfMissing(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  target.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) {
      // Parallel callers may race to create it: "already exists" (42P04) is fine.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`).catch((err: { code?: string }) => {
        if (err.code !== '42P04') throw err;
      });
    }
  } finally {
    await admin.end();
  }
}
