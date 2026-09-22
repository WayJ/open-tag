// ⋯ kebab row menu for the admin console tables: outside-click + Esc close, single-open at a time
// (opening one closes the previous via a module-level closer), optional separators and danger items.
import { useEffect, useRef, useState, Fragment } from "react";

let closeAllMenus: (() => void) | null = null;

export function RowMenu({ items, ariaLabel, disabled }: { items: { label: string; danger?: boolean; sep?: boolean; onClick: () => void }[]; ariaLabel?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    closeAllMenus = () => setOpen(false);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className={"adm-menu-wrap" + (open ? " open" : "")} ref={ref}>
      <button className="adm-menu-btn" aria-label={ariaLabel ?? "row actions"} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        onClick={() => { closeAllMenus?.(); setOpen(!open); }}>⋯</button>
      {open && <div className="adm-menu" role="menu">
        {items.map((it, i) => (
          <Fragment key={i}>
            {it.sep && <hr />}
            <button role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          </Fragment>
        ))}
      </div>}
    </div>
  );
}
