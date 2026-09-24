/**
 * Keeping the demo from taking the product down.
 *
 * The relayer allows 1000 weighted requests an hour for the whole account, and
 * a read-write turn spends roughly seven of them: identity, personal recall,
 * profile recall, handbook, then the writes. That is about 130 turns an hour
 * across the demo, Telegram, Discord and the web chat combined — so a handful
 * of curious visitors can exhaust it and leave the real bot unable to read
 * anyone's memory, which is exactly when a judge would arrive.
 *
 * Two limits, for two different failures:
 *   per visitor  — one person cannot monopolise the hour
 *   reserve      — the demo stops WRITING before the account runs dry, keeping
 *                  the last quarter of the budget for people using the real bot
 *
 * Deliberately in-process and approximate. It is a governor, not accounting.
 */

const HOUR = 60 * 60 * 1000;
const LIMIT = Number(process.env.RELAYER_HOURLY_LIMIT ?? 1000);
const RESERVE = Number(process.env.DEMO_RESERVE ?? 0.3); // fraction kept for real users
const TURNS_PER_VISITOR = Number(process.env.DEMO_TURNS_PER_VISITOR ?? 12);

/** Rough weighted cost of the relayer calls one turn makes. */
export const TURN_COST = { read: 4, write: 3 };

const spends = [];            // { at, weight }
const visitors = new Map();   // visitorId -> [timestamps]

const prune = (list) => {
  const cutoff = Date.now() - HOUR;
  while (list.length && list[0] < cutoff) list.shift();
  return list;
};

export function spend(weight) {
  const cutoff = Date.now() - HOUR;
  while (spends.length && spends[0].at < cutoff) spends.shift();
  spends.push({ at: Date.now(), weight });
}

export const spentThisHour = () => {
  const cutoff = Date.now() - HOUR;
  return spends.reduce((n, s) => (s.at >= cutoff ? n + s.weight : n), 0);
};

/**
 * What the demo may do right now.
 *
 * `write: false` does not break the demo — recall still works and the answer is
 * still real. It only stops adding to the memory, and the caller says so
 * plainly rather than silently forgetting the visitor.
 */
export function demoAllowance(visitorId) {
  const used = spentThisHour();
  const ceiling = LIMIT * (1 - RESERVE);

  const seen = prune(visitors.get(visitorId) ?? []);
  visitors.set(visitorId, seen);
  const turnsLeft = Math.max(0, TURNS_PER_VISITOR - seen.length);

  return {
    allowed: turnsLeft > 0 && used + TURN_COST.read < LIMIT,
    write: used + TURN_COST.read + TURN_COST.write < ceiling,
    turnsLeft,
    used,
    ceiling: Math.round(ceiling),
    limit: LIMIT,
  };
}

export function recordDemoTurn(visitorId, { wrote }) {
  const seen = visitors.get(visitorId) ?? [];
  seen.push(Date.now());
  visitors.set(visitorId, seen);
  spend(TURN_COST.read + (wrote ? TURN_COST.write : 0));
}

export const budgetSnapshot = () => ({
  usedThisHour: spentThisHour(),
  limit: LIMIT,
  reservedForRealUsers: Math.round(LIMIT * RESERVE),
  visitorsThisHour: [...visitors.values()].filter((v) => prune(v).length).length,
});
