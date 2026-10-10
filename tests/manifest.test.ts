import { describe, expect, it } from "vitest";
import { parseManifest, PlugError } from "../src/index.js";

const base = () => ({
  id: "demo",
  name: "Demo",
  summary: "A demo API",
  tier: "gold",
  hosts: ["api.example.com"],
  auth: { type: "apikey", header: "Authorization", format: "Bearer {secret}" },
  actions: [
    {
      id: "item_get",
      summary: "Get one item",
      scope: "read",
      method: "GET",
      path: "/items/{item}",
      query: { fields: "{fields}" },
      args: { type: "object", properties: { item: { type: "string" }, fields: { type: "string" } }, required: ["item"] },
    },
  ],
});
type Any = Record<string, any>;
const codeOf = (change: (m: Any) => void, options?: { loopback?: boolean }) => {
  const m: Any = base();
  change(m);
  try {
    parseManifest(m, options);
    return "accepted";
  } catch (error) {
    if (!(error instanceof PlugError)) throw error;
    return error.code;
  }
};
const act = (m: Any) => m.actions[0];

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    expect(codeOf(() => {})).toBe("accepted");
  });

  it.each(["{tenant}.example.com", "*.example.com", "https://api.example.com", "api.example.com:443",
    "api.example.com/v1", "user@api.example.com", "10.0.0.1", "API.example.com", "localhost"])(
    "M1 M2 refuses the host %s", (host) => {
      expect(codeOf((m) => (m.hosts = [host]))).toBe("bad-host");
    });

  it.each(["//evil.com/x", "items", "/items?x=1", "/items#x", "/a/../b", "/a/./b", "/@evil.com", "/a//b"])(
    "M3 refuses the path %s", (path) => {
      expect(codeOf((m) => (act(m).path = path))).toBe("bad-path");
    });

  it("M4 refuses a placeholder inside a segment", () => {
    expect(codeOf((m) => (act(m).path = "/items-{item}"))).toBe("bad-path");
  });

  it("M4 refuses an undeclared placeholder and an optional path argument", () => {
    expect(codeOf((m) => (act(m).path = "/items/{other}"))).toBe("bad-template");
    expect(codeOf((m) => (act(m).args.required = []))).toBe("bad-template");
    expect(codeOf((m) => (act(m).query = { q: "{nope}" }))).toBe("bad-template");
    expect(codeOf((m) => (act(m).body = { q: "{nope}" }, act(m).method = "POST"))).toBe("bad-template");
  });

  it("M5 refuses an action host that is not in hosts", () => {
    expect(codeOf((m) => (act(m).host = "evil.com"))).toBe("bad-host");
  });

  it("M6 refuses {secret} outside auth.format", () => {
    expect(codeOf((m) => (act(m).path = "/items/{secret}"))).toBe("bad-template");
    expect(codeOf((m) => (act(m).args.properties.secret = { type: "string" }))).toBe("bad-template");
    expect(codeOf((m) => (m.auth.format = "Bearer"))).toBe("bad-auth");
    expect(codeOf((m) => (m.auth.format = "{secret} {secret}"))).toBe("bad-auth");
  });

  it.each(["script", "transform", "__proto__"])("M7 refuses the unknown key %s", (key) => {
    expect(codeOf((m) => Object.defineProperty(act(m), key, { value: "x", enumerable: true }))).toBe("unknown-key");
    expect(codeOf((m) => Object.defineProperty(m, key, { value: "x", enumerable: true }))).toBe("unknown-key");
  });

  it("M8 refuses a missing or wrong scope", () => {
    expect(codeOf((m) => delete act(m).scope)).toBe("bad-manifest");
    expect(codeOf((m) => (act(m).scope = "admin"))).toBe("bad-scope");
    expect(codeOf((m) => (act(m).method = "DELETE"))).toBe("bad-scope");
  });

  it.each([["Authorization", "x"], ["cookie", "x"], ["Host", "x"], ["X-Key", "{fields}"], ["X-A", "a\r\nB: c"]])(
    "M9 refuses the header %s", (name, value) => {
      expect(codeOf((m) => (act(m).headers = { [name]: value }))).toBe("bad-header");
    });

  it("M9 refuses a header with the auth header name", () => {
    expect(codeOf((m) => ((m.auth.header = "X-Api-Key"), (act(m).headers = { "x-api-key": "1" })))).toBe("bad-header");
  });

  it("M10 refuses duplicate ids and oversized parts", () => {
    expect(codeOf((m) => m.actions.push(act(m)))).toBe("bad-manifest");
    expect(codeOf((m) => (m.summary = "x".repeat(500)))).toBe("bad-manifest");
    expect(codeOf((m) => (m.actions = Array.from({ length: 51 }, (_, i) => ({ ...act(m), id: `a${i}` }))))).toBe("bad-manifest");
  });

  it("M11 refuses a loopback host unless the caller allows it", () => {
    expect(codeOf((m) => (m.hosts = ["127.0.0.1:8080"]))).toBe("bad-host");
    expect(codeOf((m) => (m.hosts = ["127.0.0.1:8080"]), { loopback: true })).toBe("accepted");
  });

  it("M12 freezes the parsed manifest", () => {
    const m = parseManifest(base());
    expect(() => (m.hosts as string[]).push("evil.com")).toThrow();
    expect(() => ((m.actions[0] as Any).path = "/x")).toThrow();
  });
});
