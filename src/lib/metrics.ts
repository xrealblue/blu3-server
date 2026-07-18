import promClient from "prom-client";

const register = new promClient.Registry();

promClient.collectDefaultMetrics({ register });

export const httpRequestDuration = new promClient.Histogram({
  name: "blu3_http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "path", "status"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 3000, 10000],
  registers: [register],
});

export const httpRequestTotal = new promClient.Counter({
  name: "blu3_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"],
  registers: [register],
});

export const wsConnectionsActive = new promClient.Gauge({
  name: "blu3_ws_connections_active",
  help: "Currently active WebSocket connections",
  registers: [register],
});

export const wsMessagesTotal = new promClient.Counter({
  name: "blu3_ws_messages_total",
  help: "Total WebSocket messages processed",
  labelNames: ["type"],
  registers: [register],
});

export const playbackEventsTotal = new promClient.Counter({
  name: "blu3_playback_events_total",
  help: "Total playback control events",
  labelNames: ["action"],
  registers: [register],
});

export const queueOperationsTotal = new promClient.Counter({
  name: "blu3_queue_operations_total",
  help: "Total queue operations",
  labelNames: ["action"],
  registers: [register],
});

export const roomEventsTotal = new promClient.Counter({
  name: "blu3_room_events_total",
  help: "Total room lifecycle events",
  labelNames: ["event"],
  registers: [register],
});

export const errorsTotal = new promClient.Counter({
  name: "blu3_errors_total",
  help: "Total errors by source",
  labelNames: ["source"],
  registers: [register],
});

export async function metricsHandler() {
  return register.metrics();
}

export function getMetricsContentType() {
  return register.contentType;
}
