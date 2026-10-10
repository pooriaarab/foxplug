import { checkArgs } from "./args.js";
import { fail } from "./errors.js";
import { LOOPBACK, whole, type ActionDef, type Manifest, type Method } from "./manifest.js";

/** One HTTP request, built only from manifest data and checked arguments. It holds no secret. */
export interface PlugRequest {
  url: string;
  /** The manifest host, with a port for a loopback host. */
  host: string;
  method: Method;
  headers: Record<string, string>;
  body?: string;
  args: Record<string, unknown>;
}

export function findAction(manifest: Manifest, actionId: string): ActionDef {
  return manifest.actions.find((a) => a.id === actionId) ?? fail("unknown-action", `${manifest.id} has no action ${actionId}`);
}

function fill(template: unknown, args: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const name = whole(template);
    return name ? args[name] : template;
  }
  if (Array.isArray(template)) return template.map((v) => fill(v, args)).filter((v) => v !== undefined);
  if (typeof template === "object" && template !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      const value = fill(v, args);
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
  return template;
}

const text = (value: unknown) => (typeof value === "object" ? JSON.stringify(value) : String(value));

/** Build the request for one action. Throws PlugError `bad-args` or `host-mismatch`. */
export function buildRequest(manifest: Manifest, actionId: string, input: unknown): PlugRequest {
  const action = findAction(manifest, actionId);
  const args = checkArgs(action.args, input);
  const host = action.host ?? manifest.hosts[0]!;
  const path = action.path.split("/").map((seg) => {
    const name = whole(seg);
    if (!name) return seg;
    const value = text(args[name]);
    if (value === "" || value === "." || value === ".." || /[/\\]/.test(value)) {
      fail("bad-args", `"${name}" cannot be empty, "." or "..", or hold a slash`);
    }
    return encodeURIComponent(value);
  }).join("/");
  const url = new URL(`${LOOPBACK.test(host) ? "http" : "https"}://${host}${path}`);
  if (url.host !== host || url.pathname !== path || url.username || url.password) {
    fail("host-mismatch", `the URL for ${manifest.id}.${action.id} does not match its manifest host and path`);
  }
  for (const [key, template] of Object.entries(action.query ?? {})) {
    const value = fill(template, args);
    if (value !== undefined) url.searchParams.append(key, text(value));
  }
  const headers: Record<string, string> = { accept: "application/json", ...action.headers };
  const request: PlugRequest = { url: url.href, host, method: action.method, headers, args };
  if (action.body !== undefined) {
    request.body = JSON.stringify(fill(action.body, args));
    headers["content-type"] = "application/json";
  }
  return request;
}
