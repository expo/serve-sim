import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogsTool } from "../client/components/logs-tool";

describe("LogsTool", () => {
  test("keeps the count and chevron in the three-column summary row", () => {
    const html = renderToStaticMarkup(
      <LogsTool udid="DEVICE" logsEndpoint="/logs" />
    );
    const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? "";

    expect(html).toContain("data-logs");
    expect(summary).not.toContain("<span></span>");
    expect(summary).toContain("justify-self-end");
    expect(summary).toContain("Logs");
  });
});
