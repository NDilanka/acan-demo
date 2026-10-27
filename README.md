# acan-demo

A small URL shortener written for the Acan demo. It has accounts with hashed passwords,
session tokens, short links with click counts, a dashboard, and a rate limit hook that is
a no-op for now. It uses TypeScript on Node 24 with zero runtime dependencies. Node runs
the `.ts` sources directly by stripping types.

## Run

Requires Bun 1.4 or newer.

```sh
bun install        # dev dependencies only: typescript and @types/node, for type checking
bun start          # serves on PORT, default 3000
```

Check that it is up:

```sh
curl http://localhost:3000/health   # {"ok":true}
```

## Test

```sh
bun test                                  # all tests, under 5 s
bun test test/login.test.ts               # login and session flow
bun test test/links.test.ts               # link creation, redirects, ownership
bun test test/dashboard.test.ts           # dashboard contents and escaping
bun run typecheck                         # tsc --noEmit, strict mode
```

Each test starts the app on an ephemeral port with its own in-memory store, and stops it
when it finishes.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness: `{"ok":true}` |
| POST | `/api/signup` | none | `{username, password}`. Usernames are 3-32 characters of `a-z 0-9 _`. Passwords are 8-128 characters. |
| POST | `/api/login` | none | `{username, password}`. Returns `{token, user}` and sets a `session` cookie. |
| POST | `/api/logout` | session | Revokes the current session. |
| GET | `/api/links` | session | Lists your links with click counts, newest first. |
| POST | `/api/links` | session | `{url}`. Only `http` and `https` URLs are accepted. Returns the short code. |
| DELETE | `/api/links/:code` | session | Deletes one of your links. Other users get 404. |
| GET | `/dashboard` | session cookie | HTML page listing your links and click counts. |
| GET | `/:code` | none | 302 redirect to the target and records one click. |

A session is either `Authorization: Bearer <token>` or the `session` cookie.

## Layout

```
src/
  server.ts       entry point and route table; createApp() is used by tests
  middleware.ts   shared pipeline: rate limit hook, session check, JSON body, errors
  auth.ts         signup, login, sessions, scrypt password hashes
  links.ts        create, follow (count a click), delete, list
  ratelimit.ts    RateLimiter interface and a no-op stub
  dashboard.ts    server-rendered HTML with escaping
  store.ts        in-memory users, sessions and links
  errors.ts       HttpError, which maps to a status code
test/
  helpers.ts      starts a test server and makes requests
  login.test.ts
  links.test.ts
  dashboard.test.ts
```

Every route goes through `runRoute()` in `src/middleware.ts`, in this order: rate limit,
session check, handler, error mapping. The route table in `src/server.ts` declares which
routes need a session.

## Rate limiting

`src/ratelimit.ts` defines `RateLimiter.check(key)`, which is called once per request with
the client address. The stub allows everything. A real limiter implements the same method
and is passed to `createApp({ limiter })`.

## Notes

- Storage is in memory. Restarting the server clears all users and links.
- Password hashes use scrypt with the Node defaults (N=16384, r=8, p=1). The cost is stored
  in each hash. Tests pass a cheaper cost through `createApp({ passwordCost })`.
- Session tokens are random and stored only as SHA-256 hashes. They last seven days.

## License

MIT. See `LICENSE`.
