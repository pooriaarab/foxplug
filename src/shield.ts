import { sanitize, scanHtml } from "foxshield";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Run foxshield on every string. A string with no finding stays as it is. */
export function shieldStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const report = scanHtml(`<p>${escape(value)}</p>`, { mode: "static" });
    return report.findings.length === 0 ? value : sanitize(report);
  }
  if (Array.isArray(value)) return value.map(shieldStrings);
  if (typeof value === "object" && value !== null) {
    // Keys too: a response can carry instruction text in a key as well as in a value (R17).
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [shieldStrings(k) as string, shieldStrings(v)]));
  }
  return value;
}

/** Wrap a result so that the planner reads it as data. The text cannot close the tag. */
export const fence = (source: string, text: string) =>
  `<untrusted source="foxplug:${source}">\n${text.replace(/<\/untrusted/gi, "<\\/untrusted")}\n</untrusted>`;
