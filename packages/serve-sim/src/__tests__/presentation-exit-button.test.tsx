import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PresentationExitButton } from "../client/components/presentation-exit-button";

describe("PresentationExitButton", () => {
  test("renders an exit control pinned to the top-right", () => {
    const html = renderToStaticMarkup(<PresentationExitButton onClick={() => {}} />);

    expect(html).toContain("top-3");
    expect(html).toContain("right-3");
    expect(html).toContain("z-50");
    expect(html).toContain('aria-label="Exit full screen"');
  });
});
