import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SCRYPT_COST, login, logout, type ScryptCost, signup } from './auth.ts';
import { renderDashboard } from './dashboard.ts';
import { HttpError } from './errors.ts';
import { createLink, deleteLink, followLink, listLinks, toLinkView } from './links.ts';
import {
  clearSessionCookie,
  currentUser,
  readObject,
  runRoute,
  sendHtml,
  sendJson,
  sendRedirect,
  sessionCookie,
  type Context,
  type Deps,
  type Route,
} from './middleware.ts';
import { createNoopLimiter, type RateLimiter } from './ratelimit.ts';
import { Store } from './store.ts';

/**
 * The route table. Order matters: the first match wins, so /health and /dashboard
 * must stay above the catch-all /:code.
 */
const routes: Route[] = [
  { method: 'GET', path: '/health', requiresUser: false, handler: health },
  { method: 'POST', path: '/api/signup', requiresUser: false, handler: signupRoute },
  { method: 'POST', path: '/api/login', requiresUser: false, handler: loginRoute },
  { method: 'POST', path: '/api/logout', requiresUser: true, handler: logoutRoute },
  { method: 'GET', path: '/api/links', requiresUser: true, handler: listRoute },
  { method: 'POST', path: '/api/links', requiresUser: true, handler: createRoute },
  { method: 'DELETE', path: '/api/links/:code', requiresUser: true, handler: deleteRoute },
  { method: 'GET', path: '/dashboard', requiresUser: true, handler: dashboardRoute },
  { method: 'GET', path: '/:code', requiresUser: false, handler: redirectRoute },
];

interface CompiledRoute {
  route: Route;
  pattern: RegExp;
}

const compiled: CompiledRoute[] = routes.map((route) => ({ route, pattern: compilePath(route.path) }));

/** Turns "/api/links/:code" into a regex with a named group for each parameter. */
function compilePath(path: string): RegExp {
  const source = path
    .split('/')
    .map((part) =>
      part.startsWith(':')
        ? `(?<${part.slice(1)}>[^/]+)`
        : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const { route, pattern } of compiled) {
    if (route.method !== method) continue;
    const found = pattern.exec(pathname);
    if (found) return { route, params: { ...found.groups } };
  }
  return null;
}

export interface AppOptions {
  store?: Store;
  limiter?: RateLimiter;
  passwordCost?: ScryptCost;
}

export function createApp(options: AppOptions = {}): Server {
  const deps: Deps = {
    store: options.store ?? new Store(),
    limiter: options.limiter ?? createNoopLimiter(),
    passwordCost: options.passwordCost ?? DEFAULT_SCRYPT_COST,
  };
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const found = matchRoute(req.method ?? 'GET', url.pathname);
    if (!found) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    void runRoute(deps, found.route, req, res, url, found.params);
  });
}

// Handlers. Each one is thin: parse input, call the domain module, shape the response.

function health(ctx: Context): void {
  sendJson(ctx.res, 200, { ok: true });
}

async function signupRoute(ctx: Context): Promise<void> {
  const body = await readObject(ctx.req);
  const user = await signup(ctx.store, body, ctx.passwordCost);
  sendJson(ctx.res, 201, user);
}

async function loginRoute(ctx: Context): Promise<void> {
  const body = await readObject(ctx.req);
  const { token, user } = await login(ctx.store, body, ctx.passwordCost);
  sendJson(ctx.res, 200, { token, user }, { 'set-cookie': sessionCookie(token) });
}

function logoutRoute(ctx: Context): void {
  logout(ctx.store, ctx.token);
  sendJson(ctx.res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
}

function listRoute(ctx: Context): void {
  const ownerId = currentUser(ctx);
  sendJson(ctx.res, 200, { links: listLinks(ctx.store, ownerId).map(toLinkView) });
}

async function createRoute(ctx: Context): Promise<void> {
  const ownerId = currentUser(ctx);
  const body = await readObject(ctx.req);
  const link = createLink(ctx.store, ownerId, body.url);
  sendJson(ctx.res, 201, { ...toLinkView(link), shortPath: `/${link.code}` });
}

function deleteRoute(ctx: Context): void {
  const ownerId = currentUser(ctx);
  deleteLink(ctx.store, ownerId, ctx.params.code);
  sendJson(ctx.res, 200, { ok: true });
}

function dashboardRoute(ctx: Context): void {
  const userId = currentUser(ctx);
  const user = ctx.store.findUserById(userId);
  if (!user) throw new HttpError(401, 'login required');
  sendHtml(ctx.res, 200, renderDashboard(user.username, listLinks(ctx.store, userId)));
}

function redirectRoute(ctx: Context): void {
  const link = followLink(ctx.store, ctx.params.code);
  if (!link) throw new HttpError(404, 'link not found');
  sendRedirect(ctx.res, link.target);
}

// Entry point: `bun start` runs this file directly. Tests import createApp() and never reach this block.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`acan-demo listening on http://localhost:${port}`);
  });
}
