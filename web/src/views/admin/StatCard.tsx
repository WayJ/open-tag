// One KPI tile in the admin console stats row: label over a big value, optional small note.
import type { ReactNode } from "react";

export function StatCard({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="adm-stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {note && <div className="n">{note}</div>}
    </div>
  );
}
