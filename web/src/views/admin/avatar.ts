// Pure: pick a stable avatar tone + initial from an email.
const TONES = ["g-mint", "g-lav", "g-sky", "g-peach"] as const;
export type AvatarTone = (typeof TONES)[number];

export function avatarTone(email: string): AvatarTone {
  email = email.toLowerCase(); // case-normalize: same mailbox, same tone
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length];
}

export function avatarInitial(email: string): string {
  const c = email.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
