// Named HTML entities that actually appear in feed text. The numeric branch of
// `decodeEntities` covers every other codepoint, so this only needs the common
// named ones (an unknown name passes through unchanged rather than breaking).
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  times: '×',
};

/** Decode HTML character entities (`&quot;` → `"`, `&#39;` → `'`, `&#xE9;` → `é`)
 *  without a DOM/parser — pure string transform, cheap enough for the whole list. */
export const decodeEntities = (s: string): string =>
  s.includes('&')
    ? s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
          const code =
            e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      })
    : s;
