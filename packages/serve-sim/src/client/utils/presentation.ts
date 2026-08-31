function flag(params: URLSearchParams, key: string): boolean {
  return params.get(key) === "1";
}

export function presentationModeFromSearch(search: string): {
  initial: boolean;
  embedLocked: boolean;
} {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const embedLocked = flag(params, "embed");
  return { initial: embedLocked || flag(params, "fullscreen"), embedLocked };
}

export function applyFullscreenSearch(href: string, presentation: boolean): string {
  const url = new URL(href);
  if (flag(url.searchParams, "embed")) return url.toString();
  if (presentation) url.searchParams.set("fullscreen", "1");
  else url.searchParams.delete("fullscreen");
  return url.toString();
}

export function writeFullscreenSearchParam(presentation: boolean): void {
  try {
    window.history.replaceState(null, "", applyFullscreenSearch(window.location.href, presentation));
  } catch {}
}
