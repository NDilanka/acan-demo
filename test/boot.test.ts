import { describe, expect, test } from 'bun:test';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';

// Boots the runner's fixture the same way the runner does: a child bun process, PORT set, nothing else.
const ROOT = resolve(import.meta.dir, '..');
const BOOT_FIXTURE = '.acan/fixtures/boot.ts';
const BOOT_EPOCH = '2026-01-01T00:00:00.000Z';
const BOOT_TIMEOUT_MS = 60_000;

interface Reply {
  status: number;
  text: string;
}

interface Booted {
  base: string;
  call(method: string, path: string, options?: { body?: unknown; token?: string }): Promise<Reply>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

async function boot(): Promise<Booted> {
  const port = await freePort();
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', BOOT_FIXTURE],
    cwd: ROOT,
    env: { PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 400 && !ready; attempt++) {
    try {
      ready = (await fetch(`${base}/health`)).status === 200;
    } catch {
      // Not listening yet.
    }
    if (!ready) await Bun.sleep(25);
  }
  if (!ready) {
    child.kill();
    await child.exited;
    throw new Error('boot fixture did not become ready');
  }
  return {
    base,
    async call(method, path, options = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'manual',
      });
      return { status: res.status, text: await res.text() };
    },
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

async function withBoot<T>(run: (app: Booted) => Promise<T>): Promise<T> {
  const app = await boot();
  try {
    return await run(app);
  } finally {
    await app.stop();
  }
}

async function signIn(app: Booted, username: string, password: string): Promise<string> {
  const signup = await app.call('POST', '/api/signup', { body: { username, password } });
  if (signup.status !== 201) throw new Error(`signup ${username} failed: ${signup.status}`);
  const login = await app.call('POST', '/api/login', { body: { username, password } });
  if (login.status !== 200) throw new Error(`login ${username} failed: ${login.status}`);
  return JSON.parse(login.text).token as string;
}

/** The dashboard-session probe: anonymous dashboard, two users, one link, dashboards and the store. */
async function dashboardSession(app: Booted): Promise<Record<string, Reply>> {
  const transcript: Record<string, Reply> = {};
  transcript.anonymous_dashboard = await app.call('GET', '/dashboard');
  const alice = await signIn(app, 'alice', 'alice-fixture-pw');
  const bob = await signIn(app, 'bob', 'bob-fixture-pw');
  transcript.create_link = await app.call('POST', '/api/links', {
    body: { url: 'https://example.test/dash' },
    token: alice,
  });
  transcript.dashboard_alice = await app.call('GET', '/dashboard', { token: alice });
  transcript.dashboard_bob = await app.call('GET', '/dashboard', { token: bob });
  transcript.store = await app.call('GET', '/__acan/store');
  return transcript;
}

describe('boot fixture determinism', () => {
  test(
    'two boots of the same commit and fixture return identical responses',
    async () => {
      const first = await withBoot(dashboardSession);
      const second = await withBoot(dashboardSession);
      expect(second).toEqual(first);
      expect(second.dashboard_alice.text).toBe(first.dashboard_alice.text);
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'the clock starts at the fixed epoch and advance_time still moves it',
    async () => {
      await withBoot(async (app) => {
        const token = await signIn(app, 'carol', 'carol-fixture-pw');
        const first = await app.call('POST', '/api/links', {
          body: { url: 'https://example.test/one' },
          token,
        });
        expect(JSON.parse(first.text).createdAt).toBe(BOOT_EPOCH);

        const advanced = await app.call('POST', '/__acan/clock', { body: { by_ms: 3_600_000 } });
        expect(JSON.parse(advanced.text)).toEqual({ now_ms: 3_600_000 });

        const second = await app.call('POST', '/api/links', {
          body: { url: 'https://example.test/two' },
          token,
        });
        expect(JSON.parse(second.text).createdAt).toBe('2026-01-01T01:00:00.000Z');

        const dashboard = await app.call('GET', '/dashboard', { token });
        expect(dashboard.text).toContain(BOOT_EPOCH);
        expect(dashboard.text).toContain('2026-01-01T01:00:00.000Z');
      });
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'the fixed seed still gives distinct link codes and session tokens',
    async () => {
      await withBoot(async (app) => {
        const alice = await signIn(app, 'alice', 'alice-fixture-pw');
        const bob = await signIn(app, 'bob', 'bob-fixture-pw');
        expect(alice).not.toBe(bob);

        const codes = new Set<string>();
        for (let i = 0; i < 20; i++) {
          const created = await app.call('POST', '/api/links', {
            body: { url: `https://example.test/${i}` },
            token: alice,
          });
          codes.add(JSON.parse(created.text).code as string);
        }
        expect(codes.size).toBe(20);
      });
    },
    BOOT_TIMEOUT_MS,
  );
});
