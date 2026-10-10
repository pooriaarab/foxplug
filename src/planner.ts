import type { ActionDef, ArgsSchema, Manifest } from "./manifest.js";
import type { CallResult, createRunner } from "./runner.js";
import { createIndex } from "./search.js";

export interface PlannerOptions {
  runner: ReturnType<typeof createRunner>;
  manifests: Manifest[];
  /** The ids of the integrations that the user connected. Read on every call. */
  connected: () => Iterable<string>;
  /** Default 8. */
  maxCallsPerTurn?: number;
}
type Refused = { status: "refused"; reason: string; message: string };
const refused = (reason: string, message: string): Refused => ({ status: "refused", reason, message });

const closed = (properties: object, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
/** The three tool definitions to give the planner, as JSON Schema function tools. */
export const PLANNER_TOOLS = [
  { name: "plug_search", description: "Find actions in the user's connected apps. Returns ids and signatures.",
    parameters: closed({ query: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]) },
  { name: "plug_describe", description: "Get the arguments of one action id from plug_search.",
    parameters: closed({ id: { type: "string" } }, ["id"]) },
  { name: "plug_call", description: "Run one action. A write returns ask first; call again with the approval token.",
    parameters: closed({ id: { type: "string" }, args: { type: "object" }, approval: { type: "string" } }, ["id", "args"]) },
] as const;

function signature(id: string, action: ActionDef): string {
  const req = action.args.required ?? [];
  const params = Object.entries(action.args.properties).map(([k, s]) => `${k}${req.includes(k) ? "" : "?"}: ${s.type}`);
  return `${id}(${params.join(", ")}) [${action.scope}${action.scope === "read" ? "" : ": asks the user"}]`;
}
const grammar = (schema: ArgsSchema) => ({ ...schema, required: schema.required ?? [], additionalProperties: false });

export function createPlanner(options: PlannerOptions) {
  const actions = new Map<string, { m: Manifest; a: ActionDef }>();
  for (const m of options.manifests) for (const a of m.actions) actions.set(`${m.id}.${a.id}`, { m, a });
  const index = createIndex([...actions].map(([id, { m, a }]) => ({
    id, text: `${m.name} ${m.name} ${m.id} ${a.id.replace(/_/g, " ")} ${a.summary}`,
  })));
  const maxCalls = options.maxCallsPerTurn ?? 8;
  let calls = 0;
  const isConnected = (id: string) => new Set(options.connected()).has(id.split(".")[0]!);

  const search = (query: string, limit = 5) => {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 10);
    const results = index.search(query, n, isConnected).map(({ id }) => {
      const { a } = actions.get(id)!;
      return { id, summary: a.summary, scope: a.scope, signature: signature(id, a) };
    });
    const notConnected = [...new Set(index.search(query, 20, (id) => !isConnected(id)).map(({ id }) => actions.get(id)!.m.name))];
    return { results, notConnected };
  };
  const describe = (id: string) => {
    const found = actions.get(id);
    if (!found) return refused("unknown-action", `no action ${id}; use plug_search`);
    return { id, summary: found.a.summary, scope: found.a.scope, signature: signature(id, found.a), schema: grammar(found.a.args) };
  };
  const call = async (id: string, args: unknown, approval?: string): Promise<CallResult> => {
    if (!actions.has(id)) return refused("unknown-action", `no action ${id}; use plug_search`);
    if (!isConnected(id)) return refused("not-connected", `${actions.get(id)!.m.name} is not connected; ask the user to connect it`);
    if (calls >= maxCalls) return refused("turn-limit", `at most ${maxCalls} calls in one turn`);
    calls++;
    return options.runner.call(id, args, approval === undefined ? {} : { token: approval });
  };

  /** Run one planner tool call. The input is checked against the tool definition first. */
  async function run(name: string, input: unknown) {
    const tool = PLANNER_TOOLS.find((t) => t.name === name);
    if (!tool || typeof input !== "object" || input === null || Array.isArray(input)) return refused("bad-input", `unknown tool ${name}`);
    const i = input as Record<string, unknown>;
    const props = tool.parameters.properties as Record<string, { type: string }>;
    for (const key of Object.keys(i)) if (!props[key]) return refused("bad-input", `${name} has no input ${key}`);
    for (const key of tool.parameters.required) if (i[key] === undefined) return refused("bad-input", `${name} needs ${key}`);
    for (const [key, value] of Object.entries(i)) {
      const want = props[key]!.type;
      const ok = want === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
        : want === "integer" ? Number.isInteger(value) : typeof value === want;
      if (!ok) return refused("bad-input", `${name}.${key} must be ${want}`);
    }
    if (name === "plug_search") return search(i.query as string, (i.limit as number | undefined) ?? 5);
    if (name === "plug_describe") return describe(i.id as string);
    return call(i.id as string, i.args, i.approval as string | undefined);
  }

  return {
    tools: PLANNER_TOOLS,
    /** One line for the system prompt: the connected integrations, about 15 tokens each. */
    prompt: () => `Connected integrations: ${options.manifests.filter((m) => isConnected(m.id)).map((m) => `${m.name} (${m.summary})`).join(", ")}.`,
    search,
    describe,
    call,
    run,
    newTurn: () => void (calls = 0),
  };
}
