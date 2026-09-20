import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HingeControls } from "../client/components/hinge-controls";

const onChange = () => {};

describe("foldable simulator controls", () => {
  test("renders no controls without hinge capability", () => {
    expect(renderToStaticMarkup(<HingeControls onChange={onChange} />)).toBe("");
  });

  test("shows supported controls without assuming an initial position", () => {
    const html = renderToStaticMarkup(<HingeControls supported onChange={onChange} />);
    expect(html).toContain('aria-label="Fold"');
    expect(html).toContain('aria-label="Half Fold"');
    expect(html).toContain('aria-label="Unfold"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html.match(/<svg/g)).toHaveLength(4);
    const withoutTooltips = html.replace(/<span[^>]*role="tooltip"[^>]*>.*?<\/span>/g, "");
    expect(withoutTooltips).not.toMatch(/>(Fold|Half Fold|Unfold)</);
  });

  test("hides unsupported controls even if old media retains an angle", () => {
    expect(renderToStaticMarkup(<HingeControls supported={false} angle={90} onChange={onChange} />)).toBe("");
  });

  test("offers all three positions when a hinge is available", () => {
    const html = renderToStaticMarkup(<HingeControls angle={180} onChange={onChange} />);
    expect(html).toContain('aria-label="Fold position"');
    expect(html).toContain('aria-label="Fold"');
    expect(html).toContain('aria-label="Half Fold"');
    expect(html).toContain('aria-label="Unfold"');
    expect(html).toMatch(/aria-label="Unfold"[^>]*aria-pressed="true"/);
    expect(html).not.toContain("disabled");
  });

  test("marks the reported half-fold state", () => {
    const html = renderToStaticMarkup(<HingeControls angle={90} onChange={onChange} />);
    expect(html).toMatch(/aria-label="Half Fold"[^>]*aria-pressed="true"/);
  });

  test("allows unfolding while the display is folded", () => {
    const html = renderToStaticMarkup(<HingeControls angle={0} onChange={onChange} />);
    expect(html).toMatch(/aria-label="Fold"[^>]*aria-pressed="true"/);
    expect(html).not.toContain("disabled");
  });
});
