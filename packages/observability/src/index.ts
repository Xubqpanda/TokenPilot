import type { MetricsSink } from "@ecoclaw/kernel";

export function createConsoleMetricsSink(): MetricsSink {
  return {
    async emit(event, payload) {
      // Replace with OTEL/Prometheus adapter later.
      console.log(JSON.stringify({ event, payload, ts: Date.now() }));
    },
  };
}

