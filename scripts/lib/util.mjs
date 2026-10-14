// Small shared helpers.

/** Current time; MULTIPLAYER_NOW (ISO) overrides it for tests. */
export function now(env = process.env) {
  return env.MULTIPLAYER_NOW ? new Date(env.MULTIPLAYER_NOW) : new Date();
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function ago(iso, at = new Date()) {
  const ms = at - new Date(iso);
  if (!Number.isFinite(ms)) return '?';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const splitList = (v) =>
  (Array.isArray(v) ? v : [v])
    .flatMap((x) => String(x ?? '').split(','))
    .map((x) => x.trim())
    .filter(Boolean);
