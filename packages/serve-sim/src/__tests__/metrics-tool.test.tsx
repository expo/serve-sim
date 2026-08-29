import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FpsRow } from "../client/components/metrics-tool";

describe("FpsRow", () => {
  test("shows pending values before the probe reports", () => {
    const html = renderToStaticMarkup(
      <FpsRow
        refresh={null}
        rendered={null}
        refreshValues={[]}
        renderedValues={[]}
      />,
    );

    expect(html).toContain("Refresh --");
    expect(html).toContain("Rendered --");
  });

  test("shows live Refresh and Rendered values", () => {
    const html = renderToStaticMarkup(
      <FpsRow
        refresh={59.7}
        rendered={12.2}
        refreshValues={[60, 59.7]}
        renderedValues={[0, 12.2]}
      />,
    );

    expect(html).toContain("Refresh 60");
    expect(html).toContain("Rendered 12");
  });
});
