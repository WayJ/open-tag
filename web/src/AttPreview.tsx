// HTML attachment preview: sandboxed iframe modal (GitHub-preview model). The server's
// Tier 4 response already carries a CSP sandbox (unique opaque origin); the iframe
// `sandbox` attribute (empty = maximum restrictions: no scripts, no same-origin, no
// forms, no popups) is the client-side half of the defense-in-depth pair. Esc/backdrop
// closes; the title bar keeps a download link for "open raw" workflows.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconDownload } from "./icons.tsx";
import i18n from "./i18n";

export function AttPreview({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
  const [err, setErr] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); prevFocus.current?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="att-preview-bg" role="dialog" aria-modal="true" aria-label={filename} onClick={onClose}>
      <button ref={closeRef} className="lightbox-x" onClick={onClose} aria-label={i18n.t("chat.close")}><X size={20} /></button>
      <div className="att-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="att-preview-bar">
          <span className="att-preview-name" title={filename}>{filename}</span>
          <a className="im" title={i18n.t("chat.download")} href={url} download={filename} target="_blank" rel="noreferrer"><IconDownload size={14} className="im-bounce-down" /></a>
        </div>
        {err
          ? <div className="att-preview-err">{i18n.t("chat.previewError")}</div>
          : <iframe className="att-preview-frame" src={url} sandbox="" title={filename} onError={() => setErr(true)} />}
      </div>
    </div>,
    document.body,
  );
}
