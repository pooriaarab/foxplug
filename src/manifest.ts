import { fail } from "./errors.js";

export type Scope = "read" | "fill" | "submit" | "pay";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ArgType = "string" | "integer" | "number" | "boolean" | "object" | "array";

export interface ArgSpec {
  type: ArgType;
  description?: string;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  items?: { type: "string" | "integer" | "number" };
}
export interface ArgsSchema {
  type: "object";
  properties: Record<string, ArgSpec>;
  required?: string[];
}
export type Auth =
  | { type: "apikey" | "pat"; header: string; format: string }
  | { type: "oauth-pkce" }
  | { type: "none" };
export interface ActionDef {
  id: string;
  summary: string;
  scope: Scope;
  method: Method;
  host?: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  args: ArgsSchema;
  /** Field paths to keep from the response, for example `items[].title`. */
  project?: string[];
  /** The text that the approval dialog shows, with `{arg}` placeholders. */
  render?: string;
  rate?: { perMin: number };
}
export interface Manifest {
  id: string;
  name: string;
  summary: string;
  tier: "gold" | "silver" | "custom";
  hosts: string[];
  auth: Auth;
  actions: ActionDef[];
}
export interface ParseOptions {
  /** Allow `127.0.0.1:<port>` and `localhost:<port>` hosts over http. For tests only. */
  loopback?: boolean;
}

const ID = /^[a-z][a-z0-9_]{1,39}$/;
const ARG = /^[a-z][a-z0-9_]{0,39}$/;
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const LOOPBACK = /^(?:127\.0\.0\.1|localhost):\d{1,5}$/;
const SEGMENT = /^[A-Za-z0-9._~:-]+$/;
const HEADER = /^[A-Za-z0-9-]{1,60}$/;
const PROJECT = /^(?:\[\]|[A-Za-z0-9_]+(?:\[\])?)(?:\.[A-Za-z0-9_]+(?:\[\])?)*$/;
const SCOPES = ["read", "fill", "submit", "pay"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const TYPES = ["string", "integer", "number", "boolean", "object", "array"];
const BANNED_HEADERS = ["authorization", "proxy-authorization", "cookie", "host"];

type Obj = Record<string, unknown>;
function fields(value: unknown, at: string, required: string[], optional: string[] = []): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("bad-manifest", `${at} must be an object`);
  const obj = value as Obj;
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) fail("unknown-key", `${at}.${key} is not allowed`);
  }
  for (const key of required) if (!Object.hasOwn(obj, key)) fail("bad-manifest", `${at}.${key} is missing`);
  return obj;
}
const str = (value: unknown, at: string, max = 120): string =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : fail("bad-manifest", `${at} must be a string of 1 to ${max} characters`);
const list = (value: unknown, at: string, max: number): unknown[] =>
  Array.isArray(value) && value.length > 0 && value.length <= max
    ? value
    : fail("bad-manifest", `${at} must be a list of 1 to ${max} items`);
const num = (value: unknown, at: string): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fail("bad-manifest", `${at} must be a number`);

/** The argument name when the text is exactly one `{name}`, else undefined. */
export const whole = (text: string): string | undefined => /^\{([a-z][a-z0-9_]{0,39})\}$/.exec(text)?.[1];
const hasBrace = (text: string) => /[{}]/.test(text);

function checkHost(host: unknown, at: string, options: ParseOptions): string {
  if (typeof host === "string" && (HOST.test(host) || (options.loopback && LOOPBACK.test(host)))) return host;
  return fail("bad-host", `${at} must be a literal https hostname`);
}

function checkArgsSchema(value: unknown, at: string): ArgsSchema {
  const schema = fields(value, at, ["type", "properties"], ["required"]);
  if (schema.type !== "object") fail("bad-manifest", `${at}.type must be "object"`);
  const props = fields(schema.properties, `${at}.properties`, [], Object.keys(schema.properties ?? {}));
  if (Object.keys(props).length > 20) fail("bad-manifest", `${at} has more than 20 arguments`);
  for (const [name, spec] of Object.entries(props)) {
    if (!ARG.test(name) || name === "secret") fail("bad-template", `${at}: "${name}" is not a valid argument name`);
    const s = fields(spec, `${at}.${name}`, ["type"], ["description", "enum", "minimum", "maximum", "maxLength", "maxItems", "items"]);
    if (!TYPES.includes(s.type as string)) fail("bad-manifest", `${at}.${name}.type is not known`);
    if (s.description !== undefined) str(s.description, `${at}.${name}.description`, 200);
    for (const k of ["minimum", "maximum", "maxLength", "maxItems"]) if (s[k] !== undefined) num(s[k], `${at}.${name}.${k}`);
    if (s.enum !== undefined && !list(s.enum, `${at}.${name}.enum`, 50).every((e) => typeof e === "string" || typeof e === "number")) {
      fail("bad-manifest", `${at}.${name}.enum must hold strings or numbers`);
    }
    if (s.items !== undefined && !["string", "integer", "number"].includes(fields(s.items, `${at}.${name}.items`, ["type"]).type as string)) {
      fail("bad-manifest", `${at}.${name}.items.type is not known`);
    }
  }
  const required = (schema.required ?? []) as unknown[];
  if (!Array.isArray(required) || required.length > 20) fail("bad-manifest", `${at}.required must be a list of up to 20 names`);
  for (const name of required) if (!Object.hasOwn(props, name as string)) fail("bad-template", `${at}.required names an unknown argument`);
  return schema as unknown as ArgsSchema;
}

/**
 * The whole-string `{arg}` names in a body, and the `{name}` tokens inside longer
 * strings. A longer string is literal text (a GraphQL query has braces).
 */
function bodyArgs(value: unknown, at: string, depth = 0, out = { whole: [] as string[], inner: [] as string[] }) {
  if (depth > 8) fail("bad-manifest", `${at} is nested too deep`);
  if (typeof value === "string") {
    const name = whole(value);
    if (name) out.whole.push(name);
    else for (const [, inner] of value.matchAll(/\{([a-z][a-z0-9_]{0,39})\}/g)) out.inner.push(inner!);
  } else if (Array.isArray(value)) value.forEach((v, i) => bodyArgs(v, `${at}[${i}]`, depth + 1, out));
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) bodyArgs(v, `${at}.${k}`, depth + 1, out);
  }
  return out;
}

function checkAction(value: unknown, at: string, m: { hosts: string[]; authHeader?: string }, options: ParseOptions) {
  const a = fields(value, at, ["id", "summary", "scope", "method", "path", "args"],
    ["host", "query", "headers", "body", "project", "render", "rate"]);
  if (typeof a.id !== "string" || !ID.test(a.id)) fail("bad-manifest", `${at}.id must match ${ID}`);
  str(a.summary, `${at}.summary`);
  if (!SCOPES.includes(a.scope as string)) fail("bad-scope", `${at}.scope must be one of ${SCOPES.join(", ")}`);
  if (!METHODS.includes(a.method as string)) fail("bad-manifest", `${at}.method is not known`);
  if (a.scope === "read" && !["GET", "POST"].includes(a.method as string)) fail("bad-scope", `${at}: ${a.method} cannot be read`);
  if (a.host !== undefined && !m.hosts.includes(checkHost(a.host, `${at}.host`, options))) fail("bad-host", `${at}.host is not in hosts`);
  const args = checkArgsSchema(a.args, `${at}.args`);
  const declared = (name: string, where: string) => {
    if (!Object.hasOwn(args.properties, name)) fail("bad-template", `${at}.${where}: {${name}} is not a declared argument`);
  };

  const path = str(a.path, `${at}.path`, 300);
  if (!path.startsWith("/")) fail("bad-path", `${at}.path must start with /`);
  for (const seg of path.slice(1).split("/")) {
    const name = whole(seg);
    if (name) {
      declared(name, "path");
      if (!args.required?.includes(name)) fail("bad-template", `${at}.path: {${name}} must be required`);
      if (!["string", "integer", "number"].includes(args.properties[name]!.type)) fail("bad-template", `${at}.path: {${name}} must be a string or number`);
    } else if (!SEGMENT.test(seg) || seg === "." || seg === "..") fail("bad-path", `${at}.path has a bad segment "${seg}"`);
  }

  if (a.query !== undefined) {
    for (const [k, v] of Object.entries(fields(a.query, `${at}.query`, [], Object.keys(a.query as Obj)))) {
      if (!/^[A-Za-z0-9_.[\]-]{1,60}$/.test(k)) fail("bad-manifest", `${at}.query has a bad name "${k}"`);
      const name = whole(str(v, `${at}.query.${k}`, 200));
      if (name) declared(name, "query");
      else if (hasBrace(v as string)) fail("bad-template", `${at}.query.${k} must be a whole {arg} or hold no brace`);
    }
  }
  if (a.headers !== undefined) {
    for (const [k, v] of Object.entries(fields(a.headers, `${at}.headers`, [], Object.keys(a.headers as Obj)))) {
      const lower = k.toLowerCase();
      if (!HEADER.test(k) || BANNED_HEADERS.includes(lower) || lower === m.authHeader) fail("bad-header", `${at}.headers cannot set ${k}`);
      if (typeof v !== "string" || v.length > 200 || /[{}\r\n]/.test(v)) fail("bad-header", `${at}.headers.${k} must be a literal value`);
    }
  }
  if (a.body !== undefined) {
    if (a.method === "GET" || a.method === "DELETE") fail("bad-manifest", `${at}: ${a.method} cannot have a body`);
    const found = bodyArgs(a.body, `${at}.body`);
    for (const name of found.whole) declared(name, "body");
    for (const name of found.inner) {
      if (Object.hasOwn(args.properties, name)) fail("bad-template", `${at}.body: {${name}} must be a whole string to be filled`);
    }
  }
  if (a.project !== undefined) {
    for (const p of list(a.project, `${at}.project`, 20)) {
      if (typeof p !== "string" || !PROJECT.test(p)) fail("bad-manifest", `${at}.project has a bad path`);
    }
  }
  if (a.render !== undefined) {
    for (const [, name] of str(a.render, `${at}.render`, 300).matchAll(/\{([^{}]*)\}/g)) declared(name ?? "", "render");
  }
  if (a.rate !== undefined) {
    const per = fields(a.rate, `${at}.rate`, ["perMin"]).perMin;
    if (!Number.isInteger(per) || (per as number) < 1 || (per as number) > 600) fail("bad-manifest", `${at}.rate.perMin must be 1 to 600`);
  }
}

function checkAuth(value: unknown): Auth {
  const type = fields(value, "auth", ["type"], ["header", "format"]).type;
  if (type === "none" || type === "oauth-pkce") return fields(value, "auth", ["type"]) as Auth;
  if (type !== "apikey" && type !== "pat") return fail("bad-auth", "auth.type is not known");
  const auth = fields(value, "auth", ["type", "header", "format"]);
  const header = str(auth.header, "auth.header", 60);
  if (!HEADER.test(header) || ["cookie", "host"].includes(header.toLowerCase())) fail("bad-auth", "auth.header is not allowed");
  const format = str(auth.format, "auth.format", 100);
  if (format.split("{secret}").length !== 2 || hasBrace(format.replace("{secret}", "")) || /[\r\n]/.test(format)) {
    fail("bad-auth", "auth.format must hold {secret} exactly one time and no other brace");
  }
  return auth as Auth;
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Check a manifest and return a frozen copy. Throws PlugError for anything the format does not allow. */
export function parseManifest(input: unknown, options: ParseOptions = {}): Manifest {
  const m = fields(input, "manifest", ["id", "name", "summary", "tier", "hosts", "auth", "actions"]);
  if (typeof m.id !== "string" || !ID.test(m.id)) fail("bad-manifest", `manifest.id must match ${ID}`);
  str(m.name, "manifest.name", 60);
  str(m.summary, "manifest.summary");
  if (!["gold", "silver", "custom"].includes(m.tier as string)) fail("bad-manifest", "manifest.tier is not known");
  const hosts = list(m.hosts, "manifest.hosts", 10).map((h, i) => checkHost(h, `manifest.hosts[${i}]`, options));
  if (new Set(hosts).size !== hosts.length) fail("bad-manifest", "manifest.hosts has a duplicate");
  const auth = checkAuth(m.auth);
  const authHeader = "header" in auth ? auth.header.toLowerCase() : undefined;
  const actions = list(m.actions, "manifest.actions", 50);
  actions.forEach((a, i) => checkAction(a, `actions[${i}]`, { hosts, authHeader }, options));
  const ids = actions.map((a) => (a as Obj).id);
  if (new Set(ids).size !== ids.length) fail("bad-manifest", "manifest.actions has a duplicate id");
  return freeze(structuredClone(m) as unknown as Manifest);
}
