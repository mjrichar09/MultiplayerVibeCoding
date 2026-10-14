// Minimal glob support for claim paths: `**`, `*`, `?`, `{a,b}`. Patterns are
// repo-relative with forward slashes. A pattern without wildcards names a file
// or, if it ends in `/` or is a directory, everything under it.

const cache = new Map();

export function normalizePattern(pattern) {
  let p = String(pattern).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (p.endsWith('/')) p += '**';
  return p;
}

const hasWildcard = (p) => /[*?{]/.test(p);

export function globToRegExp(pattern) {
  const p = normalizePattern(pattern);
  if (cache.has(p)) return cache.get(p);
  let re = '';
  let inBrace = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      inBrace = true;
    } else if (c === '}' && inBrace) {
      re += ')';
      inBrace = false;
    } else if (c === ',' && inBrace) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // A literal path also covers everything beneath it (it may be a directory).
  const body = hasWildcard(p) ? re : `${re}(?:/.*)?`;
  const compiled = new RegExp(`^${body}$`);
  cache.set(p, compiled);
  return compiled;
}

export function matches(pattern, file) {
  return globToRegExp(pattern).test(String(file).replace(/\\/g, '/').replace(/^\.\//, ''));
}

export const matchesAny = (patterns, file) => (patterns ?? []).some((p) => matches(p, file));

/** The literal directory/file prefix of a pattern, before any wildcard segment. */
function staticPrefix(pattern) {
  const segments = normalizePattern(pattern).split('/');
  const out = [];
  for (const s of segments) {
    if (hasWildcard(s)) break;
    out.push(s);
  }
  return out;
}

const isPrefix = (short, long) => short.length <= long.length && short.every((seg, i) => seg === long[i]);

// A literal whose last segment has an extension is treated as a file, not a directory.
const looksLikeFile = (p) => !hasWildcard(p) && /\.[^/]+$/.test(p);

/**
 * Could two patterns match a common file? Exact on `files` (e.g. the repo's
 * tracked files); otherwise a conservative prefix check, so files that don't
 * exist yet still count.
 */
export function patternsOverlap(a, b, files = []) {
  a = normalizePattern(a);
  b = normalizePattern(b);
  if (files.some((f) => matches(a, f) && matches(b, f))) return true;
  if (looksLikeFile(a)) return matches(b, a);
  if (looksLikeFile(b)) return matches(a, b);
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return isPrefix(pa, pb) || isPrefix(pb, pa);
}
