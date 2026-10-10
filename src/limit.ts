const none = () => undefined;

/** Calls per tool per minute, and a pause per integration after a 429. */
export function createLimiter(now: () => number) {
  const hits = new Map<string, number[]>();
  const pausedUntil = new Map<string, number>();
  return {
    /**
     * Check and take a slot in one step, so that two calls in flight cannot both pass.
     * `wait` is the milliseconds to wait, or 0 with a slot taken. `release` gives the slot back.
     */
    take(integration: string, tool: string, perMin: number): { wait: number; release: () => void } {
      const t = now();
      const paused = (pausedUntil.get(integration) ?? 0) - t;
      if (paused > 0) return { wait: paused, release: none };
      const recent = (hits.get(tool) ?? []).filter((h) => h > t - 60_000);
      hits.set(tool, recent);
      if (recent.length >= perMin) return { wait: recent[0]! + 60_000 - t, release: none };
      recent.push(t);
      return {
        wait: 0,
        release: () => {
          const list = hits.get(tool) ?? [];
          const i = list.indexOf(t);
          if (i >= 0) list.splice(i, 1);
        },
      };
    },
    pause(integration: string, ms: number) {
      pausedUntil.set(integration, now() + ms);
    },
  };
}
