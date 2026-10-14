# foxplug

[![npm version](https://img.shields.io/npm/v/foxplug-agent)](https://www.npmjs.com/package/foxplug-agent)
[![Downloads/month](https://img.shields.io/npm/dm/foxplug-agent)](https://www.npmjs.com/package/foxplug-agent)
[![MIT license](https://img.shields.io/npm/l/foxplug-agent)](https://opensource.org/license/mit)
![Types included](https://img.shields.io/badge/types-included-blue)

[Setup](#install) · [API reference](#runtime-surfaces) · [Comparisons](#compare) · [npm package](https://www.npmjs.com/package/foxplug-agent)

foxplug is an open-source API integration library for local-model browser agents.
JSON manifests define actions; a fixed runner validates arguments, checks approvals, and calls vendor APIs.
It publishes as `foxplug-agent` and exposes three planner tools.

## Install

```bash
npm install foxplug-agent foxgate foxvault
```

Node.js 24 or later is required for this example.
The runner also works in Firefox extensions with vendor host permissions.
The package includes TypeScript types and four direct runtime dependencies: foxgate, foxshield, foxtrail, and foxvault.

## Request your first approval

Save this example as `quickstart.mjs`, then run `node quickstart.mjs`.
It stores a dummy key and requests approval without sending an API request.
No environment variables or `.env` file are required.
Success prints `ask Open the issue "Try foxplug" in me/notes`.

```js
import { createFoxgate } from "foxgate";
import { createVault } from "foxvault";
import { connectKey, createPlanner, createRunner, gateTools, GOLD } from "foxplug-agent";

const github = GOLD.find((m) => m.id === "github");
const vault = createVault();
await vault.initialize();
await connectKey(vault, github, "dry-run-placeholder");

const { gate, host } = createFoxgate({ tools: gateTools([github]) });
await host.addGrant({ scope: "read", domains: ["api.github.com"] });
await host.addGrant({ scope: "submit", domains: ["api.github.com"] });

const runner = createRunner({ manifests: [github], vault, gate });
const planner = createPlanner({ runner, manifests: [github], connected: () => ["github"] });

console.log(planner.prompt());
const found = await planner.run("plug_search", { query: "open an issue", limit: 2 });
console.log(found.results.map((r) => r.signature));

const args = { owner: "me", repo: "notes", title: "Try foxplug" };
const asked = await planner.run("plug_call", { id: "github.issue_create", args });
console.log(asked.status, asked.render);
// Show asked.render to the user. When they approve:
// const token = await host.approve(asked.requestId);
// await planner.run("plug_call", { id: "github.issue_create", args, approval: token });
```

Output:

```text
Connected integrations: GitHub (issues, pull requests and repositories).
[
  'github.issue_create(owner: string, repo: string, title: string, body?: string) [submit: asks the user]',
  'github.issue_list(owner: string, repo: string, state?: string, per_page?: integer) [read]'
]
ask Open the issue "Try foxplug" in me/notes
```

For a live GitHub call, replace the dummy key with `process.env.GITHUB_TOKEN` and use a repository you control.
Export `GITHUB_TOKEN` in your shell, or load a `.env` file with `node --env-file=.env quickstart.mjs`.
Show the approval text to the user before calling `host.approve`.
After redemption succeeds, the returned GitHub issue URL is the visible success signal.
Keep tokens outside planner messages and logs.

## How it works

```text
Planner -> plug_search / plug_describe -> connected action schema
Planner -> plug_call -> validate arguments -> build pinned request
        -> optional audit trail -> foxgate -> foxvault header -> vendor API
        <- untrusted fence <- foxshield <- projection <- key redaction
```

Manifest hosts are literal hostnames; arguments fill path segments, query values, or body values.
Reads require a grant. Writes return approval text before the request runs.
The runner checks the selected integration's key and host rule.
Responses pass through size limits, key redaction, optional projection, and text scanning.

## Why it exists

A local agent needs API actions without a separate integration relay.
foxplug keeps action definitions as data and gives the planner a small tool interface.
Composio offers managed tool authentication; n8n offers workflows with agent tool nodes.

## Compare

Scope checked on 2026-10-14 against the linked official documentation.

| Scope | foxplug | [Composio](https://docs.composio.dev/docs/authentication) | [n8n](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/) |
|---|---|---|---|
| Main role | Manifest-based API runner | Tool authentication and execution | Workflow automation with agent tools |
| Configuration | JSON manifests and JavaScript | Auth configs, sessions, toolkits | Workflow and tool nodes |
| Execution | Your Node.js app or Firefox extension | Composio API and connected accounts | n8n instance |
| Credentials | Supplied vault or link | Managed or custom auth | Workflow credentials |

n8n also documents [self-hosting on your infrastructure](https://docs.n8n.io/hosting/).

## Coverage

| Integration | Actions | Implemented scope | Live verification |
|---|---|---|---|
| GitHub | 4 | Search/list issues, create issue, comment | Pending |
| Linear | 3 | Assigned issues, teams, create issue | Pending |
| Notion | 3 | Search, read page blocks, create page | Pending |
| Todoist | 3 | Filter, create, close tasks | Pending |
| Airtable | 3 | Bases, list records, create record | Pending |
| Slack | 3 | Channels, message history, post message | Pending |
| Stripe | 3 | Balance, charges, customers; read only | Pending |
| Asana | 3 | Workspaces, assigned tasks, create task | Pending |

The source catalog has eight manifests and 25 actions: 16 reads and nine writes.
All catalog entries have local-server tests. Zero entries are live credential-checked in the repository's stated verification level.
The catalog is called `GOLD` in code; that name does not certify provider compatibility.
These manifests are implemented, rather than stubs. Confirm each provider with real credentials before relying on it.

## Common use cases

1. Firefox agent authors: discover GitHub actions and ask before opening an issue.
2. Personal-assistant authors: read Linear issues and Todoist tasks with user-supplied keys.
3. Tool-loop authors: expose the three planner tools and fetch each action schema on demand.
4. Internal API teams: define a custom JSON manifest with literal hosts and approved write scopes.
5. Finance-tool authors: read Stripe balances and charges through the read-only catalog actions.

## Features

- **Manifest validation:** literal hosts, declared arguments, and bounded schemas.
- **Action discovery:** local BM25 search over connected integrations.
- **Approvals:** foxgate checks each call; write approval tokens bind to the exact call.
- **Credential headers:** foxvault supplies the selected integration's host-pinned key.
- **Response handling:** key redaction, projection, foxshield scanning, and an untrusted-data fence.
- **Audit hooks:** optional foxtrail entries with a keyed argument hash.
- **Rate limits:** per-action slots, refusal limits, and provider 429 pauses.

## Runtime surfaces

foxplug is a library only. It has no command-line interface or Model Context Protocol (MCP) server.

| Export | What it does |
|---|---|
| `parseManifest(json, { loopback? })` | Checks a manifest and returns a frozen copy. Throws `PlugError`. `loopback` allows `127.0.0.1:<port>` hosts, for tests only. |
| `connectKey(vault, manifest, key)` | Saves a pasted key in foxvault as `vault:plug-<id>`, pinned to the manifest hosts, with a header rule from `auth.format`. |
| `gateTools(manifests)` | The foxgate tool registry: `<id>.<action>` with its scope. Pass it to `createFoxgate({ tools })`. |
| `createRunner(options)` | Returns `{ call(tool, args, { token? }) }`. Options: `manifests`, `vault`, `gate`, `trail`, `links` (foxlink links for `oauth-pkce`), `argsKey` (the HMAC key for the args hash; keep one per install), `fetch`, `now`, `maxResponseBytes`, `maxResultChars`. |
| `createPlanner(options)` | Returns `tools`, `prompt()`, `search`, `describe`, `call`, `run(name, input)`, and `newTurn()`. Options: `runner`, `manifests`, `connected`, `maxCallsPerTurn` (default 8). |
| `GOLD` | The 8 gold manifests. |
| `PLANNER_TOOLS` | The 3 tool definitions as JSON Schema. |
| `buildRequest`, `findAction`, `checkArgs`, `project`, `createIndex`, `tokenize`, `handleOf` | The parts the runner and planner use. |

`call` returns `ok` or `error` with `httpStatus`, `text`, and `truncated`;
`ask` with `requestId` and `render`; or `refused` with a `reason`. Reasons
include `not-connected`, `locked`, `rate-limited` (with `retryAfterMs`),
`redirect`, `redirect-host`, `redirect-protocol`, `too-large`, `log-failed`,
`turn-limit`, `bad-args`, and every foxgate deny reason.

## Delivery and behavior limits

- Live vendor compatibility is pending. Local tests use an HTTP fixture server.
- No automatic request retries or pagination traversal are implemented.
- The default response cap is 256 KiB; oversized bodies return `too-large`.
- Results default to 8,000 characters before the untrusted-data wrapper.
- Node.js follows at most three same-host, same-protocol redirects for GET requests.
- Browser redirects return a refusal because the browser hides their destination.
- Default rate limits are 30 calls per action per minute and ten denied or asked calls per action per minute.
- The planner permits eight calls per turn by default. Your loop must call `newTurn()` to reset it.
- Keys work in headers; query-string API keys are unsupported.
- OAuth with Proof Key for Code Exchange (PKCE) needs a caller-supplied foxlink-compatible link.
- The package has no inbound webhook listener, remote MCP client, signed catalog, or device-flow implementation.
- A supplied audit trail must accept the initial call entry before approval or network work proceeds.
- Without `argsKey`, a restarted runner generates a new hash key. Supply a stable key for comparable audit hashes.
- Scanning and untrusted-data fences do not guarantee that a planner ignores hostile response content.
- Firefox can unload background event pages; your application owns task persistence.

## Integration guides

- [GitHub approval walkthrough](#request-your-first-approval) shows vault setup, grants, and approval redemption.
- [Catalog coverage](#coverage) lists each vendor's available actions and verification level.
- [Custom manifest and runner API](#runtime-surfaces) describes schema validation and caller-supplied links.

In Firefox, request host access for each connected vendor, such as `https://api.github.com/*`.
The runner uses Fetch, readable streams, and Web Crypto rather than Node-only `Buffer` calls.

## Status

Version 0.1.1 is an early release. Manifest and runner APIs can change during the 0.x series.
Report problems through [GitHub issues](https://github.com/pooriaarab/foxplug/issues).
Public case studies are not yet published in this repository.

## FAQ

### What is foxplug?

foxplug is an API integration library for local agent applications.
Install it under the npm name `foxplug-agent`.

### Which integrations are verified?

foxplug includes eight implemented manifests tested against a local server.
Live credential verification remains pending for all eight integrations.

### Does foxplug provide a managed integration service?

foxplug runs inside your application or Firefox extension.
You supply credentials, approval UI, and task persistence.

### How is foxplug different from Composio?

foxplug sends manifest-defined requests from your runtime and uses your vault and gate.
[Composio](https://docs.composio.dev/docs/authentication) provides connected-account authentication and managed or custom auth configurations.

### How is foxplug different from n8n?

foxplug is a library for action discovery, request execution, and approval checks.
[n8n](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/) connects agent tool nodes inside workflows.

### What tools does the planner see?

foxplug exposes `plug_search`, `plug_describe`, and `plug_call`.
The planner discovers action IDs, fetches schemas, and submits checked arguments.

### Where do API keys go?

foxplug stores pasted keys through foxvault and applies a host-pinned header rule.
Applications should collect keys through their own UI rather than chat messages.

### Can foxplug create Stripe payments?

foxplug's Stripe manifest has three read actions.
It has no payment-creation action.

### Can I add my own API?

foxplug accepts custom manifests through `parseManifest`.
Custom read actions must use GET; the catalog's three approved POST reads are an internal exception.

## License

MIT. See the [MIT license text](https://opensource.org/license/mit).
