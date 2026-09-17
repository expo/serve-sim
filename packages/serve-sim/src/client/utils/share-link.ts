type ShareLocation = Pick<Location, "origin" | "pathname" | "search">;
type FragmentLocation = Pick<Location, "pathname" | "search" | "hash">;

export type ShareConfig = Pick<
  NonNullable<Window["__SIM_PREVIEW__"]>,
  "requireToken" | "execToken" | "shareUrl"
>;

function sessionToken(config: ShareConfig | null | undefined): string | undefined {
  // Without --require-token the exec token only guards /exec and must stay out of URLs.
  return config?.requireToken ? config.execToken || undefined : undefined;
}

export function shareLinkCarriesToken(config: ShareConfig | null | undefined): boolean {
  return sessionToken(config) !== undefined;
}

/** The token goes in the fragment, so the link itself never carries it to a server. */
export function previewShareUrl(
  location: ShareLocation,
  config: ShareConfig | null | undefined,
): string {
  const token = sessionToken(config);
  const url = config?.shareUrl
    ? new URL(config.shareUrl)
    : new URL(location.pathname + location.search, location.origin);
  url.searchParams.delete("token");
  if (token) {
    // Set rather than replace: --share-url may point at a page that uses the fragment itself.
    const fragment = new URLSearchParams(url.hash.slice(1));
    fragment.set("token", token);
    url.hash = fragment.toString();
  }
  return url.toString();
}

/**
 * The 401 page converts a fragment token into the query, which the gate then strips. A visit that
 * already holds the cookie never reaches that page, so the token would sit in the address bar.
 */
export function stripTokenFromFragment(
  location: FragmentLocation,
  history: Pick<History, "replaceState">,
): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has("token")) return;
  fragment.delete("token");
  const rest = fragment.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
}

/**
 * `navigator.clipboard` only exists in secure contexts. A LAN preview over plain http is not one,
 * so fall back to the legacy selection copy.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // A denied or rejected write falls through to the legacy copy below.
  } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.select();
      area.setSelectionRange(0, text.length);
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  } catch {
    return false;
  }
}
