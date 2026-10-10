const STOP = new Set(["a", "an", "the", "my", "me", "with", "of", "to", "for", "and", "in", "on", "is", "it", "all"]);

/** Lowercase words, without stop words, with a plain plural "s" removed. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** A BM25 index over short texts. It runs locally and makes no model call. */
export function createIndex(docs: { id: string; text: string }[], k1 = 1.2, b = 0.75) {
  const terms = docs.map((d) => tokenize(d.text));
  const avg = terms.reduce((n, t) => n + t.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const t of terms) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return {
    /** Ids with a score over 0, best first. `keep` filters ids before the limit. */
    search(query: string, limit: number, keep: (id: string) => boolean = () => true) {
      const words = [...new Set(tokenize(query.slice(0, 500)))];
      const scored = docs.map((d, i) => {
        const t = terms[i]!;
        let score = 0;
        for (const w of words) {
          const f = t.filter((x) => x === w).length;
          if (f === 0) continue;
          const idf = Math.log(1 + (docs.length - df.get(w)! + 0.5) / (df.get(w)! + 0.5));
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
        }
        return { id: d.id, score };
      });
      return scored.filter((s) => s.score > 0 && keep(s.id)).toSorted((x, y) => y.score - x.score).slice(0, limit);
    },
  };
}
