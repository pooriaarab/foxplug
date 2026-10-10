import { createFoxgate } from "foxgate";
import { createVault } from "foxvault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectKey, createRunner, gateTools, GOLD, parseManifest } from "../src/index.js";
import { fixture } from "./fixture.js";

const POST_READS = ["linear.issue_list", "linear.team_list", "notion.search"];
let api: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  api = await fixture();
});
afterAll(() => api.close());

describe("gold catalog", () => {
  it("G1 has 8 manifests that pass the strict validator with real hosts", () => {
    expect(GOLD.map((m) => m.id)).toEqual(["airtable", "asana", "github", "linear", "notion", "slack", "stripe", "todoist"]);
    for (const m of GOLD) {
      expect(() => parseManifest(structuredClone(m))).not.toThrow();
      expect(m.hosts.every((h) => !h.includes(":"))).toBe(true);
    }
  });

  it("G2 is frozen", () => {
    expect(() => ((GOLD[0]!.hosts as string[])[0] = "evil.com")).toThrow();
    expect(() => (GOLD as unknown as unknown[]).push({})).toThrow();
  });

  it("G3 marks every write as submit and keeps GraphQL reads to queries", () => {
    for (const m of GOLD) for (const a of m.actions) {
      const id = `${m.id}.${a.id}`;
      if (a.method !== "GET" && !POST_READS.includes(id)) expect([id, a.scope]).toEqual([id, "submit"]);
      const query = (a.body as { query?: unknown } | undefined)?.query;
      if (a.path === "/graphql" && a.scope === "read") expect(String(query)).toMatch(/^query\b/);
    }
  });

  it("G4 uses keys that the user pastes, never a shared client ID", () => {
    for (const m of GOLD) expect(["apikey", "pat"]).toContain(m.auth.type);
  });

  it.each([
    ["github.issue_search", { q: "is:open" }, "GET", "/search/issues?q=is%3Aopen", "Bearer key-github-0001"],
    ["linear.issue_list", { first: 5 }, "POST", "/graphql", "key-linear-0001"],
    ["notion.search", { query: "plan" }, "POST", "/v1/search", "Bearer key-notion-0001"],
    ["todoist.task_filter", { query: "today" }, "GET", "/api/v1/tasks/filter?query=today", "Bearer key-todoist-0001"],
    ["airtable.base_list", {}, "GET", "/v0/meta/bases", "Bearer key-airtable-0001"],
    ["slack.channel_list", {}, "GET", "/api/conversations.list?exclude_archived=true", "Bearer key-slack-0001"],
    ["stripe.balance", {}, "GET", "/v1/balance", "Bearer key-stripe-0001"],
    ["asana.workspace_list", {}, "GET", "/api/1.0/workspaces", "Bearer key-asana-0001"],
  ])("G5 %s sends the expected request", async (tool, args, method, url, authorization) => {
    const gold = GOLD.find((m) => m.id === tool.split(".")[0])!;
    const m = parseManifest({ ...structuredClone(gold), hosts: [api.host] }, { loopback: true });
    const vault = createVault();
    await vault.initialize();
    await connectKey(vault, m, `key-${m.id}-0001`, { loopback: true });
    const { gate, host } = createFoxgate({ tools: gateTools([m]) });
    await host.addGrant({ scope: "read", domains: ["127.0.0.1"] });
    expect(await createRunner({ manifests: [m], vault, gate }).call(tool, args)).toMatchObject({ status: "ok" });
    expect(api.seen.at(-1)).toMatchObject({ method, url, headers: { authorization } });
  });
});
