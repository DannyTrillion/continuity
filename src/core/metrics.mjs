/**
 * Lightweight in-process telemetry.
 *
 * Enough to show the console real numbers — recall latency, write latency, how
 * many blobs have landed — without adding a dependency or a metrics backend.
 * Rolling windows only; nothing is persisted, because none of it is truth. The
 * truth is on Walrus.
 */

const WINDOW = 50;

const series = {
  recallMs: [],
  writeMs: [],
  answerMs: [],
};

const counters = {
  blobs: 0,
  facts: 0,
  turns: 0,
  recallEmptyRetries: 0,
};

export function observe(name, ms) {
  const s = series[name];
  if (!s) return;
  s.push(Math.round(ms));
  if (s.length > WINDOW) s.shift();
}

export function count(name, by = 1) {
  if (name in counters) counters[name] += by;
}

const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const p95 = (a) => {
  if (!a.length) return 0;
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
};

export function snapshot() {
  return {
    ...counters,
    recall: { avg: avg(series.recallMs), p95: p95(series.recallMs), n: series.recallMs.length },
    write: { avg: avg(series.writeMs), p95: p95(series.writeMs), n: series.writeMs.length },
    answer: { avg: avg(series.answerMs), p95: p95(series.answerMs), n: series.answerMs.length },
    recent: { recallMs: [...series.recallMs], answerMs: [...series.answerMs] },
  };
}
