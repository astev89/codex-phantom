type MetricSnapshot = {
  counters: Record<string, number>;
  timings: Record<string, { count: number; totalMs: number; avgMs: number }>;
};

export class MetricsStore {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, { count: number; totalMs: number }>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, durationMs: number): void {
    const current = this.timings.get(name) ?? { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    this.timings.set(name, current);
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      timings: Object.fromEntries(
        [...this.timings.entries()].map(([name, value]) => [
          name,
          {
            count: value.count,
            totalMs: value.totalMs,
            avgMs: value.count === 0 ? 0 : value.totalMs / value.count
          }
        ])
      )
    };
  }
}
