import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ScreenshotToast,
  shouldDismissScreenshotToastAfterDrag,
} from "../client/components/screenshot-toast";
import type { ScreenshotToast as ScreenshotToastState } from "../client/hooks/use-screenshot-toast";

const noop = () => {};

function render(toast: ScreenshotToastState): string {
  return renderToStaticMarkup(
    <ScreenshotToast
      toast={toast}
      onReveal={noop}
      onDismiss={noop}
      onPause={noop}
      onResume={noop}
    />,
  );
}

describe("ScreenshotToast drag image", () => {
  test("dismisses after a completed drag but not a cancelled drag", () => {
    expect(shouldDismissScreenshotToastAfterDrag("copy")).toBe(true);
    expect(shouldDismissScreenshotToastAfterDrag("move")).toBe(true);
    expect(shouldDismissScreenshotToastAfterDrag("none")).toBe(false);
  });

  test("saved toast with a thumb renders an offscreen drag-image element", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: "/Users/x/Desktop/shot.png",
      thumb: "data:image/png;base64,AAAA",
    });
    expect(html).toContain('data-testid="drag-image"');
    // Parked far above the viewport via inline style — a Tailwind class here
    // can silently miss the build scan, and position:fixed would resolve
    // against the wrapper's -translate-x-1/2 containing block, both of which
    // leave the image visible in the page.
    expect(html).toMatch(/data-testid="drag-image"[^>]*style="[^"]*position:absolute/);
    expect(html).toMatch(/data-testid="drag-image"[^>]*style="[^"]*top:-9999px/);
  });

  test("toast without a thumb renders no drag-image element", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: "/Users/x/Desktop/shot.png",
    });
    expect(html).not.toContain('data-testid="drag-image"');
  });

  test("remote screenshot can be downloaded or dragged instead of opened in Finder", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      downloadUrl: "blob:https://preview.example/shot",
      downloadName: "serve-sim-screenshot.png",
      downloadFile: new File(["png"], "serve-sim-screenshot.png", {
        type: "image/png",
      }),
      thumb: "blob:https://preview.example/shot",
    });

    expect(html).toContain('aria-label="Download or drag screenshot"');
    expect(html).toContain("Drag to save");
    expect(html).not.toContain("Open in Finder");
    expect(html).toContain('draggable="true"');
  });

  test("local screenshot retains Finder and drag behavior", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: "/Users/x/Desktop/shot.png",
    });

    expect(html).toContain('aria-label="Open screenshot in Finder"');
    expect(html).toContain("Open in Finder");
    expect(html).toContain('draggable="true"');
  });
});
