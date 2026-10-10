/** Calls per tool per minute, and a pause per integration after a 429. */
export function createLimiter(now: () => number) {
  const hits = new Map<string, number[]>();
  const pausedUntil = new Map<string, number>();
  return {
    /** Milliseconds to wait before the next call, or 0. */
    wait(integration: string, tool: string, perMin: number): number {
      const t = now();
      const paused = (pausedUntil.get(integration) ?? 0) - t;
      if (paused > 0) return paused;
      const recent = (hits.get(tool) ?? []).filter((h) => h > t - 60_000);
      hits.set(tool, recent);
      return recent.length >= perMin ? recent[0]! + 60_000 - t : 0;
    },
    take(tool: string) {
      hits.get(tool)?.push(now());
    },
    pause(integration: string, ms: number) {
      pausedUntil.set(integration, now() + ms);
    },
  };
}
