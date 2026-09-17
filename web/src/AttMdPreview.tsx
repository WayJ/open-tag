// Markdown attachment preview: fetches the attachment body as text and renders it through
// the SAME battle-tested pipeline as chat messages (react-markdown + rehype-sanitize
// whitelist + remarkHtmlAsText), so raw HTML inside the .md can never execute — it is
// shown as source. No iframe needed: there is nothing scriptable to sandbox. Esc/backdrop
// closes; title bar keeps a download link.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconDownload } from "./icons.tsx";
import { MessageContent } from "./messageRender.tsx";
import i18n from "./i18n";

const noop = (): void => {};

export function AttMdPreview({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((t) => { if (alive) setText(t); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [url]);
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
        {err ? (
          <div className="att-preview-err">{i18n.t("chat.previewError")}</div>
        ) : text === null ? (
          <div className="att-preview-err">{i18n.t("chat.loading")}</div>
        ) : (
          <div className="att-preview-md">
            {/* Empty mentions/channels: no @/# ref encoding to run; nav never fires for file markdown (no tag: links). */}
            <MessageContent content={text} mentions={[]} channels={[]} nav={noop} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
