// Knowledge-base pure helpers (no DB imports — unit-tested in isolation).
// Contract: docs/superpowers/specs/2026-09-21-agent-knowledge-design.md
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_CONTENT_MAX = 32 * 1024;
export const KNOWLEDGE_PAGE_SIZE = 50;

/** Fixed at write time; the only column ILIKE scans (spec: single-column scan). */
export function buildSearchText(title: string, content: string): string {
  return `${title}\n\n${content}`;
}
/** Escape LIKE/ILIKE metacharacters so a literal "100%" query matches only literal text. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
/** Content hit-window around the first case-insensitive match (radius chars each side). */
export function makeSnippet(content: string, q: string, radius = 60): string {
  const i = content.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return content.length > radius * 2 ? content.slice(0, radius * 2) + "…" : content;
  // Leading edge keeps radius + 1 chars: the "…" glyph visually consumes one slot of context
  // (boundary pinned by test/knowledge.unit.test.ts "hit at start/end").
  const start = Math.max(0, i - radius - 1);
  const end = Math.min(content.length, i + q.length + radius);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}
