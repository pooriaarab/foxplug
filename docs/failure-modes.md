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
| M13 | An action has scope `fill`, or scope `read` on `POST`. A `read` runs with no approval, so either one lets a manifest write with no approval. | Refuse with `bad-scope`. `read` is for `GET` only. A `POST` read is allowed only for an id on the internal allowlist that `parseGold` takes. `parseManifest` passes an empty allowlist, so no other manifest can have one. | `tests/manifest.test.ts` |
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
| A7 | A string argument holds a lone surrogate (`\uD800`). `encodeURIComponent` throws `URIError` on it, and `URLSearchParams` changes it to U+FFFD. | Refuse with `bad-args`. The server never sees a changed value. | `tests/request.test.ts` |
| A8 | An argument name is also a name on `Object.prototype` (`constructor`), and the planner does not send it. | The argument counts as missing: a required one is refused with `bad-args`, and an optional one is left out. foxplug reads only own keys (`Object.hasOwn`). | `tests/request.test.ts` |

## The runner

`createRunner().call(tool, args)` runs one action. It asks foxgate, gets the
key from foxvault, sends the request, and cleans the response. The planner
and the API server are both untrusted.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| R1 | A manifest update moves an integration to a host that its stored key was not saved for. | The integration's own header rule does not cover that host, so foxplug refuses with `not-connected` and sends nothing. | `tests/runner.test.ts` |
| R2 | The API answers with a redirect to another host. | Refuse with `redirect-host`. The other host gets no request. A redirect on the same host and protocol is followed for `GET` only, at most 3 times, and foxplug decides the header again for each hop. | `tests/runner.test.ts` |
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
| R14 | Two integrations share a host, and the planner calls one that is not connected, or one whose key differs. foxvault `headersFor` applies every header rule for the host, so it can send the other integration's key. | Refuse with `not-connected` when the called integration has no stored key or link. Send only the secret of `handleOf(manifest)`, through its own header rule. | `tests/runner.test.ts` |
| R15 | The approval text of a write leaves out an argument (`render` names `title` but not `body`). The user approves text they did not see. | For a non-read action, add each argument that `render` leaves out on its own line, as JSON. | `tests/runner.test.ts` |
| R16 | The runner uses a Node-only global such as `Buffer`, so it fails in Firefox. | Use `Uint8Array` and `Array.from` only. A test runs a call with `Buffer` removed from `globalThis`. | `tests/runner.test.ts` |
| R17 | The response holds hidden characters or instruction text in an object key. | foxshield runs on keys as well as values. | `tests/runner.test.ts` |
| R18 | In a browser, `redirect: "manual"` gives an `opaqueredirect` response with status 0 and no `Location`, so foxplug cannot check the host. | Refuse with `redirect`. foxplug never treats it as a response. | `tests/runner.test.ts` |
| R19 | A same-host redirect changes the protocol (`https:` to `http:`). | Refuse with `redirect-protocol`. Nothing goes to the new URL. | `tests/runner.test.ts` (fixture server) |
| R20 | The API answers `304 Not Modified`, or another 3xx that is not a redirect. | Return it as a response (`error` with its `httpStatus`). Only 301, 302, 303, 307, and 308 are redirects. | `tests/runner.test.ts` (fixture server) |
| R21 | Calls run at the same time. A check before the awaits and a take after them let all of them pass `rate.perMin`. | Check and take the slot in one step. A call that ends in `ask`, a deny, or `log-failed` gives its slot back. | `tests/runner.test.ts` |
| R22 | A 429 has a negative, zero, or huge `Retry-After`. | Keep the wait between 1 s and 1 h. A missing value or a date waits 60 s. | `tests/runner.test.ts` (fixture server) |
| R23 | The args hash is a plain SHA-256, so anyone who reads the trail can test a guess at the args. | Use an HMAC SHA-256 with a per-install key (`argsKey`). | `tests/runner.test.ts` |
| R24 | The trail write fails after foxgate has used up the approval token. | Write the trail before foxgate decides. A failed write refuses with `log-failed`, and the token still works. | `tests/runner.test.ts` |
| R25 | An argument value holds a line break (`\n`, `\r`, U+0085, U+2028, U+2029) or another control or format character. The approval text then shows a fake extra argument line. | Escape each control, format, and line or paragraph separator in a value as `\uXXXX`. A value can never start a new line in the approval text. | `tests/runner.test.ts` |
| R26 | The trail says a call was approved when the planner only sent a token, as with a forged token. | Write a `plug.decision` entry after foxgate decides, with the real `outcome`: `allow`, `ask`, `deny`, or `bad-token` (a token that foxgate refused). | `tests/runner.test.ts` |
| R27 | The planner repeats a call that foxgate denies or asks about. Each call gives its rate slot back, but still writes a trail entry and can add to the foxgate pending queue. | Count denied and asked calls per tool against a second limit (10 a minute). Past it, refuse with `rate-limited` before the trail or foxgate sees the call. | `tests/runner.test.ts` |
| R28 | The request fails on the network (DNS, a reset, a refused connection), or the body stream fails. | Return `refused` with reason `network`, never a throw. Write a `plug.result` entry with `error: "network"`. | `tests/runner.test.ts` |

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
| P8 | An input key is a name on `Object.prototype` (`constructor`, `toString`). | Refuse with `bad-input` as an unknown input. foxplug looks up tool inputs with `Object.hasOwn`. | `tests/planner.test.ts` |

## Gold catalog

The gold catalog is 8 hand-written manifests in `src/catalog/`. The package
ships them, so a mistake in one reaches every user.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | A gold manifest does not pass the strict validator, or uses a loopback host. | Importing the catalog throws. `parseGold` runs with no `loopback` option. | `tests/catalog.test.ts` |
| G2 | Code changes a gold manifest at run time. | The manifests are frozen, so the change throws. | `tests/catalog.test.ts` |
| G3 | A gold action that changes data has scope `read`, so it can run with no approval. | Every non-GET action is `submit`, except the POST reads in `POST_READS` (`src/catalog.ts`). A GraphQL read starts with `query`, never `mutation`. | `tests/catalog.test.ts` |
| G4 | A gold manifest needs a shared OAuth client ID. | Every gold manifest uses a key or token that the user pastes (`apikey` or `pat`). | `tests/catalog.test.ts` |
| G5 | A gold manifest builds the wrong request: wrong path, method, or auth header form. | With its host moved to the fixture server, one action of each manifest sends the expected method, path, and `Authorization` value. | `tests/catalog.test.ts` (fixture server) |
| G6 | A custom manifest copies a gold POST read, but changes its body to a write. | `parseManifest` refuses it with `bad-scope` (M13). Only `parseGold` takes the `POST_READS` allowlist, and the package does not export either one. | `tests/catalog.test.ts` |
