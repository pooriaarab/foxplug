import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRequest, parseManifest, PlugError, type Manifest } from "../src/index.js";
import { fixture } from "./fixture.js";

let api: Awaited<ReturnType<typeof fixture>>;
let m: Manifest;
beforeAll(async () => {
  api = await fixture();
  m = parseManifest({
    id: "demo", name: "Demo", summary: "Demo", tier: "gold", hosts: [api.host], auth: { type: "none" },
    actions: [
      { id: "get", summary: "Get", scope: "read", method: "GET", path: "/repos/{owner}/issues",
        query: { q: "{q}", state: "open" },
        args: { type: "object", required: ["owner"], properties: {
          owner: { type: "string", maxLength: 40 }, q: { type: "string" } } } },
      { id: "make", summary: "Make", scope: "submit", method: "POST", path: "/items",
        body: { title: "{title}", n: "{n}", meta: { tag: "{tag}" } },
        args: { type: "object", required: ["title", "n"], properties: {
          title: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 9 },
          tag: { type: "string", enum: ["a", "b"] } } } },
    ],
  }, { loopback: true });
});
afterAll(() => api.close());

const send = async (id: string, args: unknown) => {
  const r = buildRequest(m, id, args);
  await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  return api.seen.at(-1)!;
};
const code = (fn: () => unknown) => {
  try {
    fn();
    return "built";
  } catch (error) {
    return error instanceof PlugError ? error.code : String(error);
  }
};

describe("buildRequest", () => {
  it("A1 refuses an undeclared argument", () => {
    expect(code(() => buildRequest(m, "get", { owner: "a", admin: true }))).toBe("bad-args");
  });

  it.each([{}, { owner: 5 }, { owner: "x".repeat(41) }])("A2 refuses bad args %j", (args) => {
    expect(code(() => buildRequest(m, "get", args))).toBe("bad-args");
  });

  it("A2 checks integers, ranges and enums", () => {
    expect(code(() => buildRequest(m, "make", { title: "t", n: 1.5 }))).toBe("bad-args");
    expect(code(() => buildRequest(m, "make", { title: "t", n: 10 }))).toBe("bad-args");
    expect(code(() => buildRequest(m, "make", { title: "t", n: 2, tag: "c" }))).toBe("bad-args");
  });

  it.each(["..", ".", "", "a/b", "a\\b"])("A3 refuses the path value %j", (owner) => {
    expect(code(() => buildRequest(m, "get", { owner }))).toBe("bad-args");
  });

  it("A3 sends an encoded value as one segment", async () => {
    const seen = await send("get", { owner: "%2e%2e?x" });
    expect(seen.url).toBe("/repos/%252e%252e%3Fx/issues?state=open");
  });

  it("A4 keeps a query value as one parameter", async () => {
    const seen = await send("get", { owner: "me", q: "a&admin=1#x" });
    const url = new URL(seen.url, "http://x");
    expect(url.searchParams.get("q")).toBe("a&admin=1#x");
    expect(url.searchParams.get("admin")).toBeNull();
  });

  it("A5 sends body values as typed JSON and leaves out unset ones", async () => {
    const seen = await send("make", { title: 'x", "admin": true', n: 3 });
    expect(JSON.parse(seen.body)).toEqual({ title: 'x", "admin": true', n: 3, meta: {} });
    expect(seen.headers["content-type"]).toBe("application/json");
  });

  it("A7 refuses a string with a lone surrogate", () => {
    for (const owner of ["\uD800", "a\uDC00b"]) expect(code(() => buildRequest(m, "get", { owner }))).toBe("bad-args");
    expect(code(() => buildRequest(m, "get", { owner: "me", q: "\uD83D" }))).toBe("bad-args");
    expect(code(() => buildRequest(m, "get", { owner: "\uD83D\uDE00" }))).toBe("built");
  });

  it("A8 never reads an argument from Object.prototype", () => {
    const action = (id: string, extra: object) => ({ id, summary: id, scope: "read", method: "GET", path: "/x", ...extra });
    const p = parseManifest({
      id: "proto", name: "Proto", summary: "Proto", tier: "gold", hosts: [api.host], auth: { type: "none" },
      actions: [
        action("path", { path: "/x/{constructor}", args: { type: "object", required: ["constructor"], properties: { constructor: { type: "string" } } } }),
        action("query", { query: { v: "{constructor}" }, args: { type: "object", properties: { constructor: { type: "string" } } } }),
      ],
    }, { loopback: true });
    expect(code(() => buildRequest(p, "path", {}))).toBe("bad-args");
    expect(buildRequest(p, "path", { constructor: "c" }).url).toBe(`http://${api.host}/x/c`);
    expect(buildRequest(p, "query", {}).url).toBe(`http://${api.host}/x`);
  });

  it("A6 throws host-mismatch for a URL that leaves the host", () => {
    const bad = structuredClone(m) as { actions: { path: string }[] };
    bad.actions[0]!.path = "@evil.com/{owner}";
    expect(code(() => buildRequest(bad as unknown as Manifest, "get", { owner: "me" }))).toBe("host-mismatch");
  });
});
