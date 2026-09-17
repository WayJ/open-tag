// Extension → MIME inference for attachment upload. undici stamps a Blob without { type }
// as application/octet-stream, which made every CLI upload a forced download on serve;
// this table restores the declared type for common formats. Unknown extensions stay
// octet-stream (fail closed) — the server-side magic-byte sniff is the backstop.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  html: "text/html", htm: "text/html", css: "text/css", csv: "text/csv",
  json: "application/json", xml: "application/xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
};

export function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}
