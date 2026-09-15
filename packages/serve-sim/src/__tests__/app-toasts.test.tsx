import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClipboardToastContent, UploadToastContent } from "../client/components/app-toasts";

describe("UploadToastContent", () => {
  test("renders determinate upload progress", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "1",
          name: "clip.mov",
          kind: "media",
          status: "uploading",
          progress: 0.42,
        }}
      />,
    );

    expect(html).toContain('data-testid="upload-toast"');
    expect(html).toContain("Uploading clip.mov… 42%");
    expect(html).toContain("width:42%");
  });

  test("renders completed media and ipa messages", () => {
    const media = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "1", name: "photo.png", kind: "media", status: "success", progress: null }}
      />,
    );
    const ipa = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "2", name: "App.ipa", kind: "ipa", status: "success", progress: null }}
      />,
    );

    expect(media).toContain("Added photo.png to Photos");
    expect(ipa).toContain("Installed App.ipa");
  });
});

describe("ClipboardToastContent", () => {
  test("renders pending, copied, and error states", () => {
    const pending = renderToStaticMarkup(
      <ClipboardToastContent toast={{ status: "pending", message: "Reading simulator clipboard…" }} />,
    );
    const copied = renderToStaticMarkup(
      <ClipboardToastContent toast={{ status: "copied", message: "Copied from simulator" }} />,
    );
    const error = renderToStaticMarkup(
      <ClipboardToastContent toast={{ status: "error", message: "Copy failed" }} />,
    );
    expect(pending).toContain("Reading simulator clipboard…");
    expect(copied).toContain("Copied from simulator");
    expect(error).toContain("Copy failed");
    expect(pending).not.toContain(">Copy</button>");
    expect(copied).not.toContain(">Copy</button>");
  });

  test("renders a paste field instead of a message in the paste state", () => {
    const html = renderToStaticMarkup(
      <ClipboardToastContent
        toast={{ status: "paste", message: "Paste here to send it to the simulator" }}
        onPaste={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Text to paste into the simulator"');
    expect(html).toContain(">Send</button>");
    expect(html).not.toContain("Paste here to send it to the simulator");
  });

  test("falls back to the message when the paste state has no handler", () => {
    const html = renderToStaticMarkup(
      <ClipboardToastContent toast={{ status: "paste", message: "Paste here" }} />,
    );
    expect(html).toContain("Paste here");
    expect(html).not.toContain(">Send</button>");
  });

  test("shows a Copy button only in the manual state", () => {
    const html = renderToStaticMarkup(
      <ClipboardToastContent toast={{ status: "manual", message: "Ready — one click to copy" }} />,
    );
    expect(html).toContain("Ready — one click to copy");
    expect(html).toContain(">Copy</button>");
  });
});
