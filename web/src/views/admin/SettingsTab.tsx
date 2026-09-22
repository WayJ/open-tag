// Settings tab of the system-admin console: deployment-level toggles. Currently one switch —
// open registration (GET/PATCH /api/admin/settings). Server-side 403/404 on POST /api/auth/register
// remains the enforcement; this toggle changes policy, the register page only reads it for UX.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../../ConfirmModal.tsx";
import type { AdminApi } from "../Admin.tsx";

export function SettingsTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [open, setOpen] = useState<boolean | null>(null); // null = still loading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Controlled-checkbox restore: cancelling the confirm leaves `open` unchanged but the DOM checkbox
  // user-toggled; bumping a counter forces the re-render that snaps it back to checked={open}.
  const [, forceRender] = useState(0);
  useEffect(() => { api("GET", "/api/admin/settings").then((r) => { if (r?.error) { setErr(r.error); setOpen(false); } else setOpen(!!r?.openRegistration); }); /* eslint-disable-next-line */ }, [api]);
  const flip = async (v: boolean) => {
    setErr("");
    if (!(await confirm({ title: t("admin.settings.regConfirmTitle"), message: v ? t("admin.settings.regOpenMsg") : t("admin.settings.regCloseMsg"), confirmLabel: t("confirm.confirm"), danger: !v }))) { forceRender((n) => n + 1); return; }
    setBusy(true);
    try {
      const r = await api("PATCH", "/api/admin/settings", { openRegistration: v });
      if (r?.error) setErr(r.error);
      else setOpen(v);
      forceRender((n) => n + 1); // a rejected PATCH also leaves `open` unchanged → restore the checkbox
    } finally { setBusy(false); }
  };
  if (open === null) return null;
  return (
    <div className="setform">
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="kv"><b>{t("admin.settings.openRegistration")}</b>
        <label><input type="checkbox" checked={open} disabled={busy} onChange={(e) => flip(e.target.checked)} /> {open ? t("admin.settings.open") : t("admin.settings.closed")}</label>
      </div>
      <p className="empty">{t("admin.settings.regHint")}</p>
    </div>
  );
}
