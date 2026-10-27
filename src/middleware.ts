import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveSession, SESSION_TTL_SECONDS, type ScryptCost } from './auth.ts';
import { HttpError } from './errors.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { Store } from './store.ts';

/**
 * The shared request pipeline. Every route passes through runRoute(), in this order:
 *   1. rate limit hook (keyed by client address)
 *   2. session check (bearer token or cookie) and the route's requiresUser flag
 *   3. the handler, which reads its JSON body with readObject()
 *   4. error mapping: HttpError becomes its status with a JSON body, anything else is a 500
 */

export const SESSION_COOKIE = 'session';

const MAX_BODY_BYTES = 16 * 1024;

export interface Deps {
  store: Store;
  limiter: RateLimiter;
  passwordCost: ScryptCost;
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  store: Store;
  passwordCost: ScryptCost;
  /** The signed-in user, or null for anonymous requests. */
  userId: string | null;
  /** The raw session token from the request, if any. */
  token: string | null;
}

export type Handler = (ctx: Context) => Promise<void> | void;

export interface Route {
  method: string;
  path: string;
  requiresUser: boolean;
  handler: Handler;
}

export async function runRoute(
  deps: Deps,
  route: Route,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: Record<string, string>,
): Promise<void> {
  try {
    const decision = deps.limiter.check(clientKey(req));
    if (!decision.allowed) {
      res.setHeader('retry-after', String(decision.retryAfterSeconds));
      throw new HttpError(429, 'too many requests');
    }

    const token = readToken(req);
    const userId = resolveSession(deps.store, token);
    if (route.requiresUser && userId === null) {
      throw new HttpError(401, 'login required');
    }

    await route.handler({
      req,
      res,
      url,
      params,
      store: deps.store,
      passwordCost: deps.passwordCost,
      userId,
      token,
    });
  } catch (err) {
    sendError(res, err);
  }
}

/** Narrows the context for handlers on routes that require a user. */
export function currentUser(ctx: Context): string {
  if (ctx.userId === null) throw new HttpError(401, 'login required');
  return ctx.userId;
}

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function readToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Reads the request body as JSON and requires a JSON object at the top level. */
export async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining past the limit so the error response can still be written.
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `body must be at most ${MAX_BODY_BYTES} bytes`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  console.error(err);
  sendJson(res, 500, { error: 'internal error' });
}
