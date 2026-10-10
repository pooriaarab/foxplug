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
| M4 | A placeholder is in part of a path segment (`/a{b}`), or names an argument that the action does not declare, or a path argument is optional. | Refuse with `bad-path` or `bad-template`. | `tests/manifest.test.ts` |
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
