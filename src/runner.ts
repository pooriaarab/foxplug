import { canonicalJson, type Gate, type ToolSpec } from "foxgate";
import type { Vault } from "foxvault";
import { fail, PlugError } from "./errors.js";
import { LOOPBACK, type ActionDef, type Manifest } from "./manifest.js";
import { buildRequest, findAction, type PlugRequest } from "./request.js";
import { fence, shieldStrings } from "./shield.js";

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
  /**
   * The HMAC SHA-256 key for the foxtrail args hash. Keep one key per install, so
   * that the same args give the same hash after a restart. Default: a new key in memory.
   */
  argsKey?: CryptoKey;
}

export type CallResult =
  | { status: "ok" | "error"; httpStatus: number; text: string }
  | { status: "ask"; requestId: string; render: string }
  | { status: "refused"; reason: string; message: string; retryAfterMs?: number };

const refuse = (reason: string, message: string, retryAfterMs?: number): CallResult =>
  retryAfterMs === undefined ? { status: "refused", reason, message } : { status: "refused", reason, message, retryAfterMs };
const hostname = (host: string) => host.replace(/:\d+$/, "");
const REDIRECTS = [301, 302, 303, 307, 308];
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
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

/** Read the body with a stream reader. undici text() and arrayBuffer() need the Node Buffer global. */
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
  }
  // A Uint8Array join, not Buffer.concat: Buffer is Node only, and foxplug runs in Firefox too (R16).
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The approval text. For a write it also shows each argument that the render leaves out (R15). */
function approvalText(m: Manifest, action: ActionDef, args: Record<string, unknown>): string {
  const used = new Set<string>();
  let text = (action.render ?? `${m.name}: ${action.summary}`).replace(/\{([a-z0-9_]+)\}/g, (_, k: string) => {
    used.add(k);
    const value = Object.hasOwn(args, k) ? args[k] : null;
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
  if (action.scope === "read") return text;
  for (const [k, v] of Object.entries(args)) if (!used.has(k) && v !== undefined) text += `\n${k}: ${JSON.stringify(v)}`;
  return text;
}

export function createRunner(options: RunnerOptions) {
  const byId = new Map<string, Manifest>();
  for (const m of options.manifests) {
    if (byId.has(m.id)) fail("bad-manifest", `two manifests have the same id ${m.id}`);
    byId.set(m.id, m);
  }
  const doFetch = options.fetch ?? fetch;
  const argsKey = options.argsKey ?? crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const linkOf = (m: Manifest) => (options.links && Object.hasOwn(options.links, m.id) ? options.links[m.id] : undefined);

  /** A key or a link is stored for this integration. A call to one that is not connected sends nothing (R14). */
  async function connected(m: Manifest): Promise<boolean> {
    if (m.auth.type === "none") return true;
    if (m.auth.type === "oauth-pkce") return linkOf(m) !== undefined;
    return (await options.vault.list()).some((s) => s.handle === handleOf(m));
  }

  /**
   * The auth header from this integration's own secret and header rule only. foxvault
   * headersFor applies every rule for the host, so on a shared host it could send the
   * key of another integration (R14).
   */
  async function keyHeader(m: Manifest, url: string): Promise<[string, string] | CallResult> {
    if ((await options.vault.status()) !== "unlocked") return refuse("locked", "the vault is locked");
    const target = new URL(url);
    const handle = handleOf(m);
    const rule = (await options.vault.headerRules()).find((r) =>
      r.handle === handle && r.hosts.includes(target.hostname) && (target.protocol === "https:" || r.allowHttp));
    const none = refuse("not-connected", `no key for ${target.host}`);
    if (!rule) return none;
    try {
      const value = await options.vault.use(handle, (secret, info) =>
        info.domains.includes(target.hostname) ? rule.format.replace("{secret}", () => secret) : undefined);
      return value === undefined ? none : [rule.header, value];
    } catch {
      return none;
    }
  }

  /** One hop. The key header is decided again for each URL, so it never leaves the hosts it was saved for. */
  async function send(m: Manifest, req: PlugRequest, url: string): Promise<Response | CallResult> {
    const init: RequestInit = { method: req.method, headers: req.headers, body: req.body, redirect: "manual" };
    if (m.auth.type === "oauth-pkce") {
      const link = linkOf(m);
      return link ? link.fetch(url, init) : refuse("not-connected", `${m.id} has no foxlink link`);
    }
    if (m.auth.type === "none") return doFetch(url, init);
    const header = await keyHeader(m, url);
    if (!Array.isArray(header)) return header;
    return doFetch(url, { ...init, headers: { ...req.headers, [header[0]]: header[1] } });
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
    if (!(await connected(m))) return refuse("not-connected", `${m.name} is not connected`);
    // An HMAC with a per-install key, so a guess at the args cannot be checked against the trail (R23).
    const mac = await crypto.subtle.sign("HMAC", await argsKey, new TextEncoder().encode(canonicalJson(req.args)));
    const argsHash = hex(mac);
    const log = (kind: string, data: object) => options.trail?.append({ actor: "foxplug", kind, data: { tool, scope: action.scope, argsHash, ...data } });
    // Write the trail before foxgate decides, so a failed write never uses up an approval token (R24).
    try {
      await log("plug.call", { approved: Boolean(callOptions.token) });
    } catch {
      return refuse("log-failed", "the audit trail cannot be written, so foxplug sent nothing");
    }
    const gateAction = { tool, args: req.args, domain: hostname(req.host), scope: action.scope };
    const decision = callOptions.token ? await options.gate.redeem(callOptions.token, gateAction) : await options.gate.check(gateAction);
    if (decision.decision === "deny") return refuse(decision.reason, decision.message);
    if (decision.decision === "ask") return { status: "ask", requestId: decision.requestId, render: approvalText(m, action, req.args) };

    const response = await send(m, req, req.url);
    if (!(response instanceof Response)) return response;
    // In a browser, redirect "manual" gives an opaque response: status 0 and no Location (R18).
    // 304 and the other 3xx codes are not redirects (R20).
    if (response.type === "opaqueredirect" || response.status === 0 || REDIRECTS.includes(response.status)) {
      return refuse("redirect", "foxplug does not follow redirects");
    }
    const raw = await readBody(response);
    // Redact first, so that no later step sees a key that the API echoed (R3).
    const clean = await options.vault.redact(raw);
    let value: unknown = clean;
    try {
      value = JSON.parse(clean);
    } catch {
      // Not JSON: keep the text.
    }
    const text = JSON.stringify(shieldStrings(value));
    await log("plug.result", { httpStatus: response.status, bytes: raw.length })?.catch(() => undefined);
    return { status: response.ok ? "ok" : "error", httpStatus: response.status, text: fence(tool, text) };
  }

  return { call };
}
