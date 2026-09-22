// CLI-side --attach argument normalization for `message send`.
//
// Extracted from the send action so the parse is unit-testable (index.ts
// auto-parses argv on import, same reason mime.ts exists). Accepts both
// shapes the flag can produce: a single string (comma-separated) or a
// string[] (variadic `--attach <ids...>`, one entry per repeat, each entry
// itself still comma-split). Dedupes so repeating an id is harmless.
export function attachmentIdsFrom(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(parts.flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean))];
}
