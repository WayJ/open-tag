// Status pill for the admin console tables — tone maps 1:1 to the .adm-pill CSS modifiers.
import type { ReactNode } from "react";

export function AdmPill({ tone, children }: { tone: "green" | "red" | "blue" | "neutral"; children: ReactNode }) {
  return <span className={`adm-pill ${tone}`}>{children}</span>;
}
