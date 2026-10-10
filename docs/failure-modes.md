# Failure modes

This file lists every way a foxplug part can fail. Each failure mode has a
test. The failure mode comes first, then the test, then the code.

foxplug lets an AI planner call web APIs with the user's own keys. A failure
here can send a key to the wrong host, or let the planner do more than the
user allowed. So every part fails closed: when foxplug is not sure, it refuses.

## Manifests

A manifest is JSON data that describes one integration. It holds no code. A
hostile author can write any manifest, so `parseManifest` must refuse every
manifest that could reach a host it does not name.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | A host holds a placeholder (`{tenant}.example.com`). | Refuse with `bad-host`. A placeholder can never pick the host. | `tests/manifest.test.ts` |
| M2 | A host is not a literal hostname: a wildcard, a scheme, a port, a path, user info, an IP address, uppercase letters. | Refuse with `bad-host`. | `tests/manifest.test.ts` |
| M3 | A path tries to change the host or leave its root: `//evil.com/x`, no leading `/`, `?`, `#`, `@`, `.` or `..` segments. | Refuse with `bad-path`. | `tests/manifest.test.ts` |
| M4 | A placeholder is in part of a path segment (`/a{b}`), or names an argument that the action does not declare, or a path argument is optional, or a body or query string holds a declared `{arg}` next to other text. | Refuse with `bad-path` or `bad-template`. Only a whole-string `{arg}` is filled. Other braces in a body string, as in a GraphQL query, are literal text. | `tests/manifest.test.ts` |
| M5 | An action names a host that is not in `hosts`. | Refuse with `bad-host`. | `tests/manifest.test.ts` |
| M6 | `{secret}` is anywhere but `auth.format`, or `auth.format` does not hold it exactly one time. | Refuse with `bad-template` or `bad-auth`. `secret` is not a valid argument name. | `tests/manifest.test.ts` |
| M7 | A manifest has a key that the format does not know (`script`, `transform`, `__proto__`). | Refuse with `unknown-key`. Data cannot carry code. | `tests/manifest.test.ts` |
| M8 | An action has no scope, an unknown scope, or `read` on `PUT`, `PATCH`, or `DELETE`. | Refuse with `bad-scope`. | `tests/manifest.test.ts` |
| M9 | A static header sets `Authorization`, `Cookie`, `Host`, or the auth header, or holds a placeholder or a line break. | Refuse with `bad-header`. | `tests/manifest.test.ts` |
| M10 | Two actions share an id, or a list or a string is over its size limit. | Refuse with `bad-manifest`. | `tests/manifest.test.ts` |
| M11 | A loopback host (`127.0.0.1:8080`) in a manifest when the caller did not pass `{ loopback: true }`. | Refuse with `bad-host`. Loopback is for tests only. | `tests/manifest.test.ts` |
| M12 | The caller changes a parsed manifest after the check. | The parsed manifest is frozen, so the change throws. | `tests/manifest.test.ts` |

## Arguments and the request

`buildRequest` turns the planner's arguments into one HTTP request. The
planner is not trusted, so its values can go only into path segments, query
values, and body values.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| A1 | The planner sends an argument that the schema does not declare. | Refuse with `bad-args`. | `tests/request.test.ts` |
| A2 | An argument has the wrong type, is out of range, is not in its `enum`, is too long, or a required argument is missing. | Refuse with `bad-args`. | `tests/request.test.ts` |
| A3 | A path argument is `..`, `.`, empty, or holds `/` or `\`. | Refuse with `bad-args`. Every other value is URL-encoded, and the server sees exactly one path segment for it. | `tests/request.test.ts` (fixture server) |
| A4 | A query argument holds `&`, `=`, or `#`. | The server sees one query parameter with the exact value. | `tests/request.test.ts` (fixture server) |
| A5 | A body argument holds quotes or JSON text. | The server sees the value as one JSON string. Numbers stay numbers. Optional arguments that are not set are left out. | `tests/request.test.ts` (fixture server) |
| A6 | The URL that foxplug builds has another host or path than the manifest says. | Throw `host-mismatch` before any request. | `tests/request.test.ts` |

## The runner

`createRunner().call(tool, args)` runs one action. It asks foxgate, gets the
key from foxvault, sends the request, and cleans the response. The planner
and the API server are both untrusted.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| R1 | A manifest update moves an integration to a host that its stored key was not saved for. | foxvault adds no header for that host, so foxplug refuses with `not-connected` and sends nothing. | `tests/runner.test.ts` |
| R2 | The API answers with a redirect to another host. | Refuse with `redirect-host`. The other host gets no request. A redirect on the same host is followed, at most 3 times, and foxvault decides the header again for each hop. | `tests/runner.test.ts` |
| R3 | The API echoes the key in its response or in an error. | foxvault `redact` replaces the key with its handle before anything else reads the body. | `tests/runner.test.ts` |
| R4 | The response holds hidden characters or text that gives the model orders. | foxshield removes hidden characters and wraps instruction text in `<untrusted-data>`. The whole result is inside `<untrusted source="foxplug:…">`, and the data cannot close that tag. | `tests/runner.test.ts` |
| R5 | The planner calls a write action with no approval, or uses the approval for call A on call B, or uses one approval two times. | `ask` with no request sent. Then foxgate refuses with `action-changed` or `token-used`, and nothing is sent. | `tests/runner.test.ts` |
| R6 | The planner calls an action that no grant covers. | Refuse with the foxgate reason (`no-grant`). Nothing is sent. | `tests/runner.test.ts` |
| R7 | The planner calls an action faster than its `rate.perMin`, or the API answers 429. | Refuse with `rate-limited` and `retryAfterMs`. Nothing is sent until that time. foxplug reads `Retry-After` from the 429. | `tests/runner.test.ts` |
| R8 | The response is larger than `maxResponseBytes`, or the result is longer than `maxResultChars`. | Stop reading and refuse with `too-large`. A long result is cut and has `truncated: true`. | `tests/runner.test.ts` |
| R9 | The response holds fields the planner does not need, for example a private email. | Only the `project` paths reach the planner. A `__proto__` path cannot change a prototype. | `tests/runner.test.ts` |
| R10 | The audit trail cannot be written. | Refuse with `log-failed` and send nothing. Each call writes a foxtrail entry with an args hash, never the args, the key, or the body. | `tests/runner.test.ts` |
| R11 | The vault is locked. | Refuse with `locked`. Nothing is sent. | `tests/runner.test.ts` |
| R12 | An `oauth-pkce` integration has no foxlink link. | Refuse with `not-connected`. With a link, only `link.fetch` sends the request. | `tests/runner.test.ts` |
| R13 | Two manifests have the same id. | `createRunner` throws `bad-manifest`. | `tests/runner.test.ts` |

## Planner tools

The planner sees three tools: `plug_search`, `plug_describe`, and
`plug_call`. It never sees the action list itself. Its input is untrusted.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | The planner calls an action of an integration that the user has not connected. | Refuse with `not-connected`. Nothing is sent. | `tests/planner.test.ts` |
| P2 | The planner makes more calls in one turn than `maxCallsPerTurn` (default 8). | Refuse with `turn-limit` until `newTurn()`. | `tests/planner.test.ts` |
| P3 | A search matches an integration that is not connected. | Return no action from it. Return only its name in `notConnected`, so the planner can offer to connect it. | `tests/planner.test.ts` |
| P4 | A query is empty, has no known word, or is very long. | Return an empty list, or search the first 500 characters. Never return more than `limit` (at most 10) results. | `tests/planner.test.ts` |
| P5 | The planner sends a tool name or an input shape that is not known (`args` as a string, extra keys). | Refuse with `bad-input`. | `tests/planner.test.ts` |
| P6 | `plug_describe` gets an id that does not exist. | Refuse with `unknown-action`. | `tests/planner.test.ts` |
| P7 | The schema that `plug_describe` gives for a grammar allows extra keys. | Every schema has `additionalProperties: false`. | `tests/planner.test.ts` |

## Gold catalog

The gold catalog is 8 hand-written manifests in `src/catalog/`. The package
ships them, so a mistake in one reaches every user.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | A gold manifest does not pass the strict validator, or uses a loopback host. | Importing the catalog throws. `parseManifest` runs with no `loopback` option. | `tests/catalog.test.ts` |
| G2 | Code changes a gold manifest at run time. | The manifests are frozen, so the change throws. | `tests/catalog.test.ts` |
| G3 | A gold action that changes data has scope `read`, so it can run with no approval. | Every non-GET action is `submit`, except a short list of POST reads. A GraphQL read starts with `query`, never `mutation`. | `tests/catalog.test.ts` |
| G4 | A gold manifest needs a shared OAuth client ID. | Every gold manifest uses a key or token that the user pastes (`apikey` or `pat`). | `tests/catalog.test.ts` |
| G5 | A gold manifest builds the wrong request: wrong path, method, or auth header form. | With its host moved to the fixture server, one action of each manifest sends the expected method, path, and `Authorization` value. | `tests/catalog.test.ts` (fixture server) |
