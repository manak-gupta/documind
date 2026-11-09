import type pg from 'pg';

export interface DocumentEvent {
  documentId: string;
  userId: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  pageCount: number | null;
}

type Listener = (event: DocumentEvent) => void;

export interface DocumentEvents {
  subscribe(userId: string, listener: Listener): () => void;
}

// One LISTEN connection per API process, fanned out to every open browser tab.
// (Opening one Postgres connection per SSE client would exhaust the pool quickly.)
export class DocumentEventHub implements DocumentEvents {
  private readonly listeners = new Map<string, Set<Listener>>();
  private client: pg.PoolClient | null = null;
  private closed = false;
  private readonly pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async start(pool: pg.Pool): Promise<DocumentEventHub> {
    const hub = new DocumentEventHub(pool);
    // If the database isn't up yet (e.g. containers starting in parallel), don't crash the API:
    // /health reports 503 meanwhile, and the hub keeps retrying in the background.
    await hub.connect().catch(() => hub.reconnectSoon());
    return hub;
  }

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query('UNLISTEN document_status').catch(() => {});
      client.release();
    }
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      const event = JSON.parse(msg.payload) as DocumentEvent;
      for (const listener of this.listeners.get(event.userId) ?? []) listener(event);
    });
    // If the database restarts, this connection dies. Reconnect, or live progress
    // would silently stop for every user until the API is restarted.
    client.on('error', () => {
      client.release(true);
      if (this.client === client) this.client = null;
      this.reconnectSoon();
    });
    await client.query('LISTEN document_status');
    this.client = client;
  }

  // Keeps retrying every 2 s until the database is back (or the hub is closed).
  private reconnectSoon(): void {
    if (this.closed) return;
    setTimeout(() => this.connect().catch(() => this.reconnectSoon()), 2_000).unref();
  }
}

// For tests and for apps that don't need live updates.
export const noEvents: DocumentEvents = { subscribe: () => () => {} };
