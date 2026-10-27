import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, signIn, startTestServer } from './helpers.ts';

test('dashboard lists only the signed-in user links with click counts', async () => {
  const srv = await startTestServer();
  try {
    const alice = await signIn(srv.baseUrl, 'alice_01');
    const bob = await signIn(srv.baseUrl, 'bob_02');

    const first = await call(srv.baseUrl, 'POST', '/api/links', {
      token: alice,
      body: { url: 'https://example.com/docs?a=1&b=2' },
    });
    const second = await call(srv.baseUrl, 'POST', '/api/links', {
      token: alice,
      body: { url: 'https://example.org/' },
    });
    const bobs = await call(srv.baseUrl, 'POST', '/api/links', {
      token: bob,
      body: { url: 'https://example.net/' },
    });

    // Two clicks on the first link, none on the second.
    await call(srv.baseUrl, 'GET', `/${first.body.code}`);
    await call(srv.baseUrl, 'GET', `/${first.body.code}`);

    const page = await call(srv.baseUrl, 'GET', '/dashboard', { cookie: `session=${alice}` });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(page.text, /Links for alice_01/);
    assert.ok(page.text.includes(first.body.code), 'shows the first link');
    assert.ok(page.text.includes(second.body.code), 'shows the second link');
    assert.ok(!page.text.includes(bobs.body.code), 'does not show another user link');
    assert.match(page.text, /<td class="clicks">2<\/td>/);
    assert.match(page.text, /<td class="clicks">0<\/td>/);
    assert.match(page.text, /2 click\(s\) in total/);
  } finally {
    await srv.close();
  }
});

test('dashboard escapes link targets', async () => {
  const srv = await startTestServer();
  try {
    const alice = await signIn(srv.baseUrl, 'alice_01');
    await call(srv.baseUrl, 'POST', '/api/links', {
      token: alice,
      body: { url: 'https://example.com/docs?a=1&b=2' },
    });

    const page = await call(srv.baseUrl, 'GET', '/dashboard', { cookie: `session=${alice}` });
    assert.ok(page.text.includes('https://example.com/docs?a=1&amp;b=2'));
    assert.ok(!page.text.includes('a=1&b=2'), 'raw ampersand must not reach the page');
  } finally {
    await srv.close();
  }
});

test('dashboard needs a session and shows an empty state for a new user', async () => {
  const srv = await startTestServer();
  try {
    const anonymous = await call(srv.baseUrl, 'GET', '/dashboard');
    assert.equal(anonymous.status, 401);

    const alice = await signIn(srv.baseUrl, 'alice_01');
    const empty = await call(srv.baseUrl, 'GET', '/dashboard', { cookie: `session=${alice}` });
    assert.equal(empty.status, 200);
    assert.match(empty.text, /No links yet/);
  } finally {
    await srv.close();
  }
});
