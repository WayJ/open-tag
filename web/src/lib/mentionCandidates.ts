// Channel-scoped @-mention candidates: client side of GET /api/channels/:id/mention-candidates.
// handleKey moves here from Composer (single normalization for pool + filter); the pool itself is
// server-authored — the picker never falls back to a whole-workspace guess.
export const handleKey = (s: string) => s.normalize("NFC").toLowerCase();

export interface MentionCandidate { id: string; name: string; displayName?: string | null; avatarUrl?: string | null; kind: "agent" | "human"; member: boolean }

export function filterMentionCandidates(pool: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = handleKey(query ?? "");
  return pool
    .filter((c) => c.name && handleKey(c.name).includes(q))
    .sort((a, b) => Number(b.member) - Number(a.member) || handleKey(a.name).localeCompare(handleKey(b.name)))
    .slice(0, limit);
}
