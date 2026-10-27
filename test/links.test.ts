import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, signIn, startTestServer } from './helpers.ts';

test('a short link redirects to its target and counts clicks', async () => {
  const srv = await startTestServer();
  try {
    const token = await signIn(srv.baseUrl, 'alice_01');
    const created = await call(srv.baseUrl, 'POST', '/api/links', {
      token,
      body: { url: 'https://example.com/docs?a=1&b=2' },
    });
    assert.equal(created.status, 201);
    const { code, target, shortPath } = created.body;
    assert.equal(target, 'https://example.com/docs?a=1&b=2');
    assert.equal(shortPath, `/${code}`);

    const hit = await call(srv.baseUrl, 'GET', `/${code}`);
    assert.equal(hit.status, 302);
    assert.equal(hit.headers.get('location'), target);

    const list = await call(srv.baseUrl, 'GET', '/api/links', { token });
    assert.equal(list.status, 200);
    assert.equal(list.body.links.length, 1);
    assert.equal(list.body.links[0].clicks, 1);
    assert.equal(list.body.links[0].ownerId, undefined, 'owner id stays server side');
  } finally {
    await srv.close();
  }
});

test('only http and https targets are accepted', async () => {
  const srv = await startTestServer();
  try {
    const token = await signIn(srv.baseUrl, 'alice_01');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', '']) {
      const reply = await call(srv.baseUrl, 'POST', '/api/links', { token, body: { url } });
      assert.equal(reply.status, 400, `expected 400 for ${JSON.stringify(url)}`);
    }
  } finally {
    await srv.close();
  }
});

test('creating links requires a session', async () => {
  const srv = await startTestServer();
  try {
    const anonymous = await call(srv.baseUrl, 'POST', '/api/links', {
      body: { url: 'https://example.com/' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error, 'login required');
  } finally {
    await srv.close();
  }
});

test('only the owner can delete a link; others get 404', async () => {
  const srv = await startTestServer();
  try {
    const alice = await signIn(srv.baseUrl, 'alice_01');
    const bob = await signIn(srv.baseUrl, 'bob_02');
    const created = await call(srv.baseUrl, 'POST', '/api/links', {
      token: alice,
      body: { url: 'https://example.com/' },
    });
    const { code } = created.body;

    const intruder = await call(srv.baseUrl, 'DELETE', `/api/links/${code}`, { token: bob });
    assert.equal(intruder.status, 404);

    const stillThere = await call(srv.baseUrl, 'GET', `/${code}`);
    assert.equal(stillThere.status, 302);

    const removed = await call(srv.baseUrl, 'DELETE', `/api/links/${code}`, { token: alice });
    assert.equal(removed.status, 200);

    const gone = await call(srv.baseUrl, 'GET', `/${code}`);
    assert.equal(gone.status, 404);
  } finally {
    await srv.close();
  }
});

test('unknown codes return 404 and never redirect', async () => {
  const srv = await startTestServer();
  try {
    const reply = await call(srv.baseUrl, 'GET', '/nosuchcode');
    assert.equal(reply.status, 404);
    assert.equal(reply.headers.get('location'), null);
  } finally {
    await srv.close();
  }
});
