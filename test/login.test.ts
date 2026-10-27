import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SCRYPT_COST } from '../src/auth.ts';
import { call, PASSWORD, signIn, startTestServer } from './helpers.ts';

test('login with the right password returns a session token and stores only a hash', async () => {
  // The only test that runs the production scrypt cost, so the default path is covered end to end.
  const srv = await startTestServer({ passwordCost: DEFAULT_SCRYPT_COST });
  try {
    const signup = await call(srv.baseUrl, 'POST', '/api/signup', {
      body: { username: 'alice_01', password: PASSWORD },
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.username, 'alice_01');
    assert.equal(signup.body.passwordHash, undefined, 'the hash must not leave the server');

    const stored = srv.store.findUserByName('alice_01');
    assert.ok(stored, 'user is stored');
    assert.ok(stored.passwordHash.startsWith(`scrypt$${DEFAULT_SCRYPT_COST.N}$8$1$`));
    assert.ok(!stored.passwordHash.includes(PASSWORD));

    const login = await call(srv.baseUrl, 'POST', '/api/login', {
      body: { username: 'alice_01', password: PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(typeof login.body.token, 'string');
    assert.match(login.headers.get('set-cookie') ?? '', /^session=[^;]+; HttpOnly; SameSite=Strict/);

    const me = await call(srv.baseUrl, 'GET', '/api/links', { token: login.body.token });
    assert.equal(me.status, 200, 'the token from a good login authenticates');
  } finally {
    await srv.close();
  }
});

test('login with a bad password fails and issues no token', async () => {
  const srv = await startTestServer();
  try {
    await signIn(srv.baseUrl, 'alice_01');

    const bad = await call(srv.baseUrl, 'POST', '/api/login', {
      body: { username: 'alice_01', password: 'not the password' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'invalid username or password');
    assert.equal(bad.body.token, undefined);
    assert.equal(bad.headers.get('set-cookie'), null);
  } finally {
    await srv.close();
  }
});

test('login for an unknown user gets the same 401 as a bad password', async () => {
  const srv = await startTestServer();
  try {
    const reply = await call(srv.baseUrl, 'POST', '/api/login', {
      body: { username: 'nobody_here', password: PASSWORD },
    });
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error, 'invalid username or password');
  } finally {
    await srv.close();
  }
});

test('logout revokes the session token', async () => {
  const srv = await startTestServer();
  try {
    const token = await signIn(srv.baseUrl, 'alice_01');

    const out = await call(srv.baseUrl, 'POST', '/api/logout', { token });
    assert.equal(out.status, 200);

    const after = await call(srv.baseUrl, 'GET', '/api/links', { token });
    assert.equal(after.status, 401);
  } finally {
    await srv.close();
  }
});

test('signup rejects a taken username and a short password', async () => {
  const srv = await startTestServer();
  try {
    await signIn(srv.baseUrl, 'alice_01');

    const taken = await call(srv.baseUrl, 'POST', '/api/signup', {
      body: { username: 'Alice_01', password: PASSWORD },
    });
    assert.equal(taken.status, 409);

    const short = await call(srv.baseUrl, 'POST', '/api/signup', {
      body: { username: 'bob_02', password: 'short' },
    });
    assert.equal(short.status, 400);
  } finally {
    await srv.close();
  }
});
