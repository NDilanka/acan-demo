// Boot fixture for the Acan runner. The runner starts this file in the prepared worktree of one
// commit, once per probe sequence, and sets PORT to a free port it picked. The commit's own
// createApp() supplies the pipeline, limiter and defaults. This file adds only the runner's two
// trusted endpoints: a controlled clock and a store snapshot.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../../src/server.ts';
import { Store } from '../../src/store.ts';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

interface StoreMaps {
  usersById: Map<string, unknown>;
  sessions: Map<string, unknown>;
  links: Map<string, unknown>;
}

const CLOCK_PATH = '/__acan/clock';
const STORE_PATH = '/__acan/store';
const EPOCH_MS = Date.UTC(2026, 0, 1);
const MAX_ADVANCE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_BODY_BYTES = 1024;

// Session expiry and rate-limit windows read the clock. Both time sources come from one value,
// so base A, base B and the candidate run on the same schedule.
const clock = { nowMs: EPOCH_MS };
Date.now = () => clock.nowMs;
performance.now = () => clock.nowMs - EPOCH_MS;

// A new process gets a new store. The runner starts one process for every probe sequence.
const store = new Store();
const app = createApp({ store });

const [pipeline] = app.listeners('request') as RequestListener[];
if (!pipeline) throw new Error('createApp registered no request listener');
app.removeAllListeners('request');
app.on('request', (req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === CLOCK_PATH) {
    void handleClock(req, res);
  } else if (path === STORE_PATH) {
    handleStore(req, res);
  } else {
    pipeline(req, res);
  }
});

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a free port number');
}
// Loopback only. The clock endpoint moves app time, so it must not listen on other interfaces.
app.listen(port, '127.0.0.1', () => {
  console.log(`acan boot listening on 127.0.0.1:${port}`);
});

function handleStore(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'use GET' });
    return;
  }
  try {
    sendJson(res, 200, snapshotStore(store));
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'snapshot failed' });
  }
}

async function handleClock(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'use POST' });
    return;
  }
  let text: string;
  try {
    text = await readBody(req, MAX_CLOCK_BODY_BYTES);
  } catch {
    sendJson(res, 413, { error: 'body is too large' });
    return;
  }
  const byMs = parseAdvance(text);
  if (byMs === undefined) {
    sendJson(res, 400, { error: 'body must be {"by_ms": integer from 0 to 86400000}' });
    return;
  }
  clock.nowMs += byMs;
  sendJson(res, 200, { now_ms: clock.nowMs - EPOCH_MS });
}

/** The by_ms of an advance request, or undefined when the body does not carry a valid one. */
function parseAdvance(text: string): number | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || !('by_ms' in body)) return undefined;
  const byMs = body.by_ms;
  if (typeof byMs !== 'number' || !Number.isSafeInteger(byMs)) return undefined;
  return byMs >= 0 && byMs <= MAX_ADVANCE_MS ? byMs : undefined;
}

/**
 * The store keeps its maps private, so the snapshot reads them directly and sees the app's real
 * state. A changed layout fails the snapshot instead of returning an empty one.
 */
function snapshotStore(target: Store): Record<'users' | 'sessions' | 'links', unknown[]> {
  const maps = target as unknown as Partial<StoreMaps>;
  if (
    !(maps.usersById instanceof Map) ||
    !(maps.sessions instanceof Map) ||
    !(maps.links instanceof Map)
  ) {
    throw new Error('store layout changed: snapshot unavailable');
  }
  return {
    users: [...maps.usersById.values()],
    sessions: [...maps.sessions.values()],
    links: [...maps.links.values()],
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) reject(new Error('body is too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
