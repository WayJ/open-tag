import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonCommandSet } from "../machineUi.ts";
import { copyText } from "../lib/clipboard.ts";

// Renders a daemon command set inside a modal: "custom" → one codebox (env-template override or the
// npx fallback); "platform" → a bash / PowerShell tab switcher (seg-pill, defaulted from the browser
// UA — detected once at mount, not re-detected on prop change) over the shared codebox. Owns the
// copy button + "Copied" flash + prompt fallback; the connect wizard and daemon-update modal embed
// it under their own label.
export function CommandTabs({ set }: { set: DaemonCommandSet }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"bash" | "powershell">(() => (navigator.userAgent.includes("Windows") ? "powershell" : "bash"));
  const [copied, setCopied] = useState(false);
  const command = set.kind === "custom" ? set.command : set[tab];
  const copy = async () => {
    if (!await copyText(command)) { window.prompt(t("misc.connectModalCopyBtn"), command); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <>
      {set.kind === "platform" && (
        <div className="seg-pill" style={{ marginBottom: 6 }}>
          <button className={"seg-opt" + (tab === "bash" ? " on" : "")} onClick={() => setTab("bash")}>{t("misc.cmdTabBash")}</button>
          <button className={"seg-opt" + (tab === "powershell" ? " on" : "")} onClick={() => setTab("powershell")}>{t("misc.cmdTabPowershell")}</button>
        </div>
      )}
      <div className="codebox"><code className="grow">{command}</code><button className="joinbtn" onClick={copy}>{copied ? t("misc.connectModalCopied") : t("misc.connectModalCopyBtn")}</button></div>
    </>
  );
}
