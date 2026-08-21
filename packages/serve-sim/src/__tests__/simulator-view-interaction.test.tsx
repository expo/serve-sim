import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorView } from "../client/simulator/SimulatorView";

describe("SimulatorView interaction", () => {
  test("leaves the video surface visible without accepting pointer input", () => {
    const html = renderToStaticMarkup(
      <SimulatorView
        url="http://127.0.0.1:3100"
        streamMode="mjpeg"
        hideControls
        interactive={false}
      />,
    );

    expect(html).toContain('data-interactive="false"');
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("cursor:default");
    expect(html).toContain("stream.mjpeg");
  });
});
