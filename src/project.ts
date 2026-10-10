type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(value: unknown, parts: string[]): unknown {
  const [head, ...rest] = parts;
  if (head === undefined) return value;
  const many = head.endsWith("[]");
  const key = many ? head.slice(0, -2) : head;
  const child = key === "" ? value : isObj(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  if (child === undefined) return undefined;
  const sub = many ? (Array.isArray(child) ? child.map((c) => pick(c, rest) ?? null) : undefined) : pick(child, rest);
  if (sub === undefined) return undefined;
  return key === "" ? sub : Object.fromEntries([[key, sub]]);
}

function merge(a: unknown, b: unknown): unknown {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]));
  if (isObj(a) && isObj(b)) {
    // Object.fromEntries defines own keys, so "__proto__" cannot set a prototype (R9).
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, merge(a[k], b[k])]));
  }
  return b;
}

/** Keep only the given field paths (`items[].title`, `[].id`). Returns null when none match. */
export function project(value: unknown, paths: readonly string[]): unknown {
  let out: unknown;
  for (const path of paths) out = merge(out, pick(value, path.split(".")));
  return out ?? null;
}
