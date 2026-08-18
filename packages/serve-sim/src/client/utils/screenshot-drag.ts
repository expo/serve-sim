export const DOWNLOAD_URL_TYPE = "DownloadURL";

type ScreenshotDataTransfer = {
  setData: (format: string, data: string) => void;
  items: {
    add: (file: File) => unknown;
  };
};

function downloadFileName(name: string): string {
  // DownloadURL uses colons and newlines as delimiters. Screenshot names are
  // generated locally, but sanitize anyway so this helper remains safe to use
  // with an arbitrary name later.
  return name.replace(/[:\r\n]/g, "-");
}

/**
 * Populate both drag representations synchronously during dragstart:
 *
 * - Chromium's DownloadURL lets the OS receive a browser-backed download.
 * - A real File lets standard in-browser drop targets consume the same bytes,
 *   including serve-sim's own simulator media drop zone.
 */
export function setBrowserScreenshotDragData(
  dataTransfer: ScreenshotDataTransfer,
  { file, url }: { file: File; url: string },
): void {
  dataTransfer.setData(
    DOWNLOAD_URL_TYPE,
    `${file.type || "image/png"}:${downloadFileName(file.name)}:${url}`,
  );

  // Some browsers expose the standard File item but reject programmatic
  // additions. Keep DownloadURL functional in that case.
  try {
    dataTransfer.items.add(file);
  } catch {}
}
