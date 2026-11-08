import type { FastifyReply } from 'fastify';

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
}

// Opens a Server-Sent Events response: a long-lived HTTP response the server keeps writing
// "event:/data:" blocks to. One-way server -> browser, plain HTTP (works through proxies and
// Cloudflare), and browsers reconnect automatically.
export function openSse(reply: FastifyReply): SseStream {
  reply.hijack(); // we own the raw response now; Fastify must not try to end it
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // tell reverse proxies not to buffer the stream
  });
  res.write('retry: 3000\n\n'); // browser reconnect delay if the connection drops

  // Proxies (and Cloudflare, after 100 s) close connections that look idle.
  // A comment line every 15 s keeps it open and costs a few bytes.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  let closed = false;
  const closeHandlers: (() => void)[] = [];

  // The response's 'close' fires when the client disconnects (or we end it).
  // (The request's 'close' is NOT reliable for this: it fires once the body has been read.)
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closeHandlers) fn();
  });

  return {
    send(event, data) {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!closed) res.end();
    },
    get closed() {
      return closed;
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
  };
}
