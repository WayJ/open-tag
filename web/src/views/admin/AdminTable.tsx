// Thin table wrapper for the admin console: uniform thead/rows/empty state on top of .adm-card +
// .adm-table. children are the <tr> rows; pass cols as strings, or objects for a right-aligned
// column (e.g. actions).
import type { ReactNode } from "react";

export function AdminTable({ cols, children, empty }: { cols: (string | { label: string; right?: boolean })[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children : [children];
  return (
    <div className="adm-card">
      <table className="adm-table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} style={typeof c === "object" && c.right ? { textAlign: "right" } : undefined}>
                {typeof c === "object" ? c.label : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {!rows.some(Boolean) && empty && <div className="adm-empty">{empty}</div>}
    </div>
  );
}
