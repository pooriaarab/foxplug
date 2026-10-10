import { createFoxgate } from "foxgate";
import { createVault } from "foxvault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlanner, createRunner, gateTools, parseManifest, type Manifest } from "../src/index.js";
import { fixture } from "./fixture.js";

let api: Awaited<ReturnType<typeof fixture>>;
let tasks: Manifest;
let notes: Manifest;
const args = { type: "object", required: ["title"], properties: { title: { type: "string" }, due: { type: "string" } } };
beforeAll(async () => {
  api = await fixture();
  const make = (id: string, name: string, words: string) => parseManifest({
    id, name, summary: `${name} ${words}`, tier: "gold", hosts: [api.host], auth: { type: "none" },
    actions: [
      { id: `${words}_list`, summary: `List my open ${words}`, scope: "read", method: "GET", path: `/${words}`,
        args: { type: "object", properties: {} } },
      { id: `${words}_create`, summary: `Create a new ${words.slice(0, -1)} with a title`, scope: "submit",
        method: "POST", path: `/${words}`, body: { title: "{title}" }, args },
    ],
  }, { loopback: true });
  tasks = make("tasks", "Tasks", "tasks");
  notes = make("notes", "Notes", "notes");
});
afterAll(() => api.close());

async function setup(maxCallsPerTurn?: number) {
  const manifests = [tasks, notes];
  const { gate, host } = createFoxgate({ tools: gateTools(manifests) });
  await host.addGrant({ scope: "read", domains: ["127.0.0.1"] });
  await host.addGrant({ scope: "submit", domains: ["127.0.0.1"] });
  const vault = createVault();
  await vault.initialize();
  const runner = createRunner({ manifests, vault, gate });
  return { host, planner: createPlanner({ runner, manifests, connected: () => ["tasks"], maxCallsPerTurn }) };
}

describe("planner tools", () => {
  it("runs search, describe, ask, approve and call as a planner would", async () => {
    const { host, planner } = await setup();
    expect(planner.prompt()).toBe("Connected integrations: Tasks (Tasks tasks).");
    const found = (await planner.run("plug_search", { query: "create a task" })) as { results: { id: string }[] };
    expect(found.results[0]).toMatchObject({ id: "tasks.tasks_create", scope: "submit" });
    const described = await planner.run("plug_describe", { id: "tasks.tasks_create" });
    expect(described).toMatchObject({ signature: "tasks.tasks_create(title: string, due?: string) [submit: asks the user]" });
    const asked = (await planner.run("plug_call", { id: "tasks.tasks_create", args: { title: "Buy milk" } })) as { requestId: string };
    const token = await host.approve(asked.requestId);
    expect(await planner.run("plug_call", { id: "tasks.tasks_create", args: { title: "Buy milk" }, approval: token }))
      .toMatchObject({ status: "ok" });
    expect(api.seen.at(-1)).toMatchObject({ method: "POST", body: '{"title":"Buy milk"}' });
  });

  it("P1 refuses an integration that is not connected", async () => {
    const { planner } = await setup();
    const before = api.seen.length;
    expect(await planner.run("plug_call", { id: "notes.notes_list", args: {} })).toMatchObject({ status: "refused", reason: "not-connected" });
    expect(api.seen).toHaveLength(before);
  });

  it("P2 stops at maxCallsPerTurn until the next turn", async () => {
    const { planner } = await setup(2);
    await planner.call("tasks.tasks_list", {});
    await planner.call("tasks.tasks_list", {});
    expect(await planner.call("tasks.tasks_list", {})).toMatchObject({ status: "refused", reason: "turn-limit" });
    planner.newTurn();
    expect(await planner.call("tasks.tasks_list", {})).toMatchObject({ status: "ok" });
  });

  it("P3 names an unconnected integration and hides its actions", async () => {
    const { planner } = await setup();
    const r = planner.search("list my notes");
    expect(r.results.every((x) => x.id.startsWith("tasks."))).toBe(true);
    expect(r.notConnected).toEqual(["Notes"]);
  });

  it("P4 handles empty, unknown and very long queries", async () => {
    const { planner } = await setup();
    expect(planner.search("").results).toEqual([]);
    expect(planner.search("zzzz qqqq").results).toEqual([]);
    expect(planner.search(`${"task ".repeat(1000)}`, 50).results.length).toBeLessThanOrEqual(10);
  });

  it.each([
    ["plug_eval", { code: "1" }],
    ["plug_call", { id: "tasks.tasks_list", args: "{}" }],
    ["plug_search", { query: "x", admin: true }],
    ["plug_describe", {}],
  ])("P5 refuses %s with %j", async (name, input) => {
    const { planner } = await setup();
    expect(await planner.run(name, input)).toMatchObject({ status: "refused", reason: "bad-input" });
  });

  it("P6 refuses describe for an unknown id", async () => {
    const { planner } = await setup();
    expect(planner.describe("tasks.nope")).toMatchObject({ status: "refused", reason: "unknown-action" });
  });

  it("P7 gives a closed schema for the grammar", async () => {
    const { planner } = await setup();
    expect(planner.describe("tasks.tasks_create")).toMatchObject({ schema: { additionalProperties: false, required: ["title"] } });
    for (const tool of planner.tools) expect(tool.parameters.additionalProperties).toBe(false);
  });
});
