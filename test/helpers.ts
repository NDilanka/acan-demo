import type { AddressInfo } from 'node:net';
import { type ScryptCost } from '../src/auth.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

export const PASSWORD = 'correct horse battery';

/** Cheap scrypt work for tests. Production uses DEFAULT_SCRYPT_COST, which takes about 0.2 s per hash here. */
export const TEST_SCRYPT_COST: ScryptCost = { N: 1024, r: 8, p: 1 };

export interface TestServer {
  baseUrl: string;
  store: Store;
  close(): Promise<void>;
}

export interface TestServerOptions {
  passwordCost?: ScryptCost;
}

/** Starts the app on an ephemeral port with a fresh in-memory store. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const store = new Store();
  const server = createApp({ store, passwordCost: options.passwordCost ?? TEST_SCRYPT_COST });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export interface CallOptions {
  body?: unknown;
  token?: string;
  cookie?: string;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // Parsed JSON, or undefined when the reply is not JSON.
  body: any;
}

export async function call(baseUrl: string, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON, for example the dashboard page.
  }
  return { status: res.status, headers: res.headers, text, body };
}

/** Signs up and logs in, then returns the session token. */
export async function signIn(baseUrl: string, username: string, password = PASSWORD): Promise<string> {
  const signup = await call(baseUrl, 'POST', '/api/signup', { body: { username, password } });
  if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${signup.text}`);
  const login = await call(baseUrl, 'POST', '/api/login', { body: { username, password } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  return login.body.token as string;
}
