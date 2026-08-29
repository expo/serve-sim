import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogsDrawer } from "../client/components/logs-drawer";

describe("LogsDrawer", () => {
  test("renders the bottom-drawer chrome when open", () => {
    const html = renderToStaticMarkup(
      <LogsDrawer
        open
        onClose={() => {}}
        udid="DEVICE"
        logsEndpoint="/logs"
        currentAppPid={99}
        height={320}
        leftInset={0}
        rightInset={0}
        onResizePointerDown={() => {}}
      />
    );

    expect(html).toContain("data-logs");
    expect(html).toContain("Device logs");
    expect(html).toContain("Logs");
    expect(html).toContain("Filter");
    expect(html).toContain("All processes");
    expect(html).toContain("Current app");
    expect(html).toContain("Log levels");
    expect(html).toContain("Debug, off");
    expect(html).toContain("Error, on");
    expect(html).toContain("Fault, on");
    expect(html).toContain("Clear");
    expect(html).toContain("Pause");
    expect(html).toContain("Close logs");
    expect(html).toContain("Resize logs drawer");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("translateY(0)");
  });

  test("slides off-screen when closed", () => {
    const html = renderToStaticMarkup(
      <LogsDrawer
        open={false}
        onClose={() => {}}
        udid="DEVICE"
        logsEndpoint="/logs"
        height={320}
        leftInset={0}
        rightInset={0}
        onResizePointerDown={() => {}}
      />
    );

    expect(html).toContain("translateY(100%)");
    expect(html).toContain('aria-hidden="true"');
  });
});
