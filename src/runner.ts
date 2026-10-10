import { canonicalJson, type Gate, type ToolSpec } from "foxgate";
import type { Vault } from "foxvault";
import { fail, PlugError } from "./errors.js";
import { createLimiter } from "./limit.js";
import { LOOPBACK, type Manifest } from "./manifest.js";
import { project } from "./project.js";
import { buildRequest, findAction, type PlugRequest } from "./request.js";
import { fence, shieldStrings } from "./shield.js";

/** foxvault only adds a header to requests that come from this origin. */
const ORIGIN = "moz-extension://foxplug-runner/";

export interface RunnerOptions {
  manifests: Manifest[];
  vault: Vault;
  /** The planner side of foxgate. Register `gateTools(manifests)` with it. */
  gate: Gate;
  /** A foxtrail Log, or anything with the same `append`. */
  trail?: { append(entry: { actor: string; kind: string; data?: unknown }): Promise<unknown> };
  /** foxlink links for `oauth-pkce` integrations, by integration id. */
  links?: Record<string, { fetch(url: string, init?: RequestInit): Promise<Response> }>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Default 256 KiB. */
  maxResponseBytes?: number;
  /** Default 8000, about 2,000 tokens. */
  maxResultChars?: number;
}

export type CallResult =
  | { status: "ok" | "error"; httpStatus: number; text: string; truncated: boolean }
  | { status: "ask"; requestId: string; render: string }
  | { status: "refused"; reason: string; message: string; retryAfterMs?: number };

const refuse = (reason: string, message: string, retryAfterMs?: number): CallResult =>
  retryAfterMs === undefined ? { status: "refused", reason, message } : { status: "refused", reason, message, retryAfterMs };
const hostname = (host: string) => host.replace(/:\d+$/, "");
export const handleOf = (manifest: Manifest) => `vault:plug-${manifest.id}`;

/** The foxgate tool registry: `<integration>.<action>` with the scope from the manifest. */
export function gateTools(manifests: Manifest[]): Record<string, ToolSpec> {
  return Object.fromEntries(manifests.flatMap((m) => m.actions.map((a) => [`${m.id}.${a.id}`, a.scope])));
}

/** Store a pasted API key or token in foxvault, pinned to the manifest hosts. */
export async function connectKey(vault: Vault, manifest: Manifest, key: string, options: { loopback?: boolean } = {}) {
  const auth = manifest.auth;
  if (auth.type !== "apikey" && auth.type !== "pat") return fail("bad-auth", `${manifest.id} does not use a pasted key`);
  if (!options.loopback && manifest.hosts.some((h) => LOOPBACK.test(h))) return fail("bad-host", "loopback hosts need { loopback: true }");
  const handle = handleOf(manifest);
  const hosts = [...new Set(manifest.hosts.map(hostname))];
  const allowHttp = options.loopback === true;
  await vault.remove(handle);
  for (const rule of await vault.headerRules()) if (rule.handle === handle) await vault.removeHeader(rule.id);
  await vault.set(handle, key, { domains: hosts, allowHttp });
  await vault.injectHeader({ handle, header: auth.header, hosts, format: auth.format, allowHttp });
}

async function readCapped(response: Response, max: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createRunner(options: RunnerOptions) {
  const byId = new Map<string, Manifest>();
  for (const m of options.manifests) {
    if (byId.has(m.id)) fail("bad-manifest", `two manifests have the same id ${m.id}`);
    byId.set(m.id, m);
  }
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const limiter = createLimiter(now);
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  const maxChars = options.maxResultChars ?? 8000;

  /** One hop. foxvault decides the auth header for each URL, so a header never leaves the hosts it was saved for. */
  async function send(m: Manifest, req: PlugRequest, url: string): Promise<Response | CallResult> {
    const init: RequestInit = { method: req.method, headers: req.headers, body: req.body, redirect: "manual" };
    if (m.auth.type === "oauth-pkce") {
      const link = options.links?.[m.id];
      return link ? link.fetch(url, init) : refuse("not-connected", `${m.id} has no foxlink link`);
    }
    if (m.auth.type === "none") return doFetch(url, init);
    if ((await options.vault.status()) !== "unlocked") return refuse("locked", "the vault is locked");
    const start = Object.entries(req.headers).map(([name, value]) => ({ name, value }));
    const out = await options.vault.headersFor({ url, originUrl: ORIGIN, requestHeaders: start }, ORIGIN);
    const header = m.auth.header.toLowerCase();
    const headers = (out?.requestHeaders ?? []).filter((h) => h.value !== undefined).map((h) => [h.name, h.value!] as [string, string]);
    if (!headers.some(([name]) => name.toLowerCase() === header)) return refuse("not-connected", `no key for ${new URL(url).host}`);
    return doFetch(url, { ...init, headers });
  }

  async function call(tool: string, args: unknown, callOptions: { token?: string } = {}): Promise<CallResult> {
    const [id = "", actionId = ""] = tool.split(".");
    let req: PlugRequest;
    const m = byId.get(id);
    try {
      if (!m) return fail("unknown-action", `no integration ${id}`);
      req = buildRequest(m, actionId, args);
    } catch (error) {
      if (error instanceof PlugError) return refuse(error.code, error.message);
      throw error;
    }
    const action = findAction(m, actionId);
    const wait = limiter.wait(m.id, tool, action.rate?.perMin ?? 30);
    if (wait > 0) return refuse("rate-limited", `wait ${Math.ceil(wait / 1000)} s`, wait);

    const gateAction = { tool, args: req.args, domain: hostname(req.host), scope: action.scope };
    const decision = callOptions.token ? await options.gate.redeem(callOptions.token, gateAction) : await options.gate.check(gateAction);
    if (decision.decision === "deny") return refuse(decision.reason, decision.message);
    if (decision.decision === "ask") {
      const render = (action.render ?? `${m.name}: ${action.summary}`).replace(/\{([a-z0-9_]+)\}/g, (_, k: string) =>
        typeof req.args[k] === "string" ? (req.args[k] as string) : JSON.stringify(req.args[k] ?? null));
      return { status: "ask", requestId: decision.requestId, render };
    }
    limiter.take(tool);

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(req.args))));
    const argsHash = Buffer.from(digest).toString("hex");
    const log = (kind: string, data: object) => options.trail?.append({ actor: "foxplug", kind, data: { tool, scope: action.scope, argsHash, ...data } });
    try {
      await log("plug.call", { approved: Boolean(callOptions.token) });
    } catch {
      return refuse("log-failed", "the audit trail cannot be written, so foxplug sent nothing");
    }

    let url = req.url;
    let response: Response | CallResult = refuse("redirect", "too many redirects");
    for (let hop = 0; hop < 4; hop++) {
      response = await send(m, req, url);
      if (!(response instanceof Response) || response.status < 300 || response.status > 399) break;
      const next = new URL(response.headers.get("location") ?? "", url);
      if (next.host !== req.host) return refuse("redirect-host", `${req.host} redirected to another host`);
      if (req.method !== "GET") return refuse("redirect", "foxplug follows redirects for GET only");
      url = next.href;
      response = refuse("redirect", "too many redirects");
    }
    if (!(response instanceof Response)) return response;
    if (response.status === 429) {
      const ms = Math.min(Number(response.headers.get("retry-after")) * 1000 || 60_000, 3_600_000);
      limiter.pause(m.id, ms);
      return refuse("rate-limited", `${m.name} asked foxplug to slow down`, ms);
    }
    const raw = await readCapped(response, maxBytes);
    if (raw === undefined) return refuse("too-large", `the response is over ${maxBytes} bytes`);
    // Redact first, so that no later step sees a key that the API echoed (R3).
    const clean = await options.vault.redact(raw);
    let value: unknown = clean;
    try {
      value = JSON.parse(clean);
      if (response.ok && action.project) value = project(value, action.project);
    } catch {
      // Not JSON: keep the text.
    }
    let text = JSON.stringify(shieldStrings(value));
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    await log("plug.result", { httpStatus: response.status, bytes: raw.length, truncated })?.catch(() => undefined);
    return { status: response.ok ? "ok" : "error", httpStatus: response.status, text: fence(tool, text), truncated };
  }

  return { call };
}
