import { fail } from "./errors.js";
import type { ArgSpec, ArgsSchema } from "./manifest.js";

/** A UTF-16 high surrogate with no low one after it, or a low one with no high one before it (A7). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function checkValue(spec: ArgSpec | { type: string }, value: unknown, at: string) {
  const s = spec as ArgSpec;
  const bad = (why: string) => fail("bad-args", `${at} ${why}`);
  switch (s.type) {
    case "string":
      if (typeof value !== "string") bad("must be a string");
      if ((value as string).length > (s.maxLength ?? 4000)) bad("is too long");
      if (LONE_SURROGATE.test(value as string)) bad("holds a lone surrogate");
      break;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) bad("must be a number");
      if (s.type === "integer" && !Number.isInteger(value)) bad("must be an integer");
      if (s.minimum !== undefined && (value as number) < s.minimum) bad(`must be ${s.minimum} or more`);
      if (s.maximum !== undefined && (value as number) > s.maximum) bad(`must be ${s.maximum} or less`);
      break;
    case "boolean":
      if (typeof value !== "boolean") bad("must be true or false");
      break;
    case "array":
      if (!Array.isArray(value) || value.length > (s.maxItems ?? 100)) bad("must be a list that is not too long");
      (value as unknown[]).forEach((v, i) => checkValue(s.items ?? { type: "string" }, v, `${at}[${i}]`));
      break;
    case "object":
      if (!plain(value) || JSON.stringify(value).length > 10_000) bad("must be a JSON object under 10,000 characters");
      break;
  }
  if (s.enum && !s.enum.includes(value as string | number)) bad(`must be one of ${s.enum.join(", ")}`);
}

/** Check planner arguments against an action schema. Extra and missing arguments are refused. */
export function checkArgs(schema: ArgsSchema, input: unknown): Record<string, unknown> {
  if (!plain(input)) return fail("bad-args", "args must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) fail("bad-args", `"${key}" is not an argument of this action`);
  }
  // Own keys only, so a name such as "constructor" never reads Object.prototype (A8).
  for (const key of schema.required ?? []) if (!Object.hasOwn(input, key) || input[key] === undefined) fail("bad-args", `"${key}" is required`);
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) checkValue(schema.properties[key]!, value, `"${key}"`);
  }
  return input;
}
