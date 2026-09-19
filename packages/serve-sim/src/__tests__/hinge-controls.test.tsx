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
    for (const label of ["Closed", "Open", "Laptop", "Book", "Tent"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('aria-pressed="true"');
    expect(html.match(/mask-image:/g)).toHaveLength(5);
    expect(html).toContain('aria-valuetext="Unknown"');
    expect(html).toMatch(/type="number"[^>]*value=""/);
    expect(html).toContain("—");
    const withoutTooltips = html.replace(/<span[^>]*role="tooltip"[^>]*>.*?<\/span>/g, "");
    expect(withoutTooltips).not.toMatch(/>(Closed|Open|Laptop|Book|Tent)</);
  });

  test("hides unsupported controls even if old media retains an angle", () => {
    expect(renderToStaticMarkup(<HingeControls supported={false} angle={90} onChange={onChange} />)).toBe("");
  });

  test("identifies the fully open endpoint without assuming a partial pose", () => {
    const html = renderToStaticMarkup(<HingeControls angle={180} onChange={onChange} />);
    expect(html).toContain('aria-label="Fold position"');
    expect(html).toMatch(/aria-label="Open"[^>]*aria-pressed="true"/);
    expect(html).not.toMatch(/<button[^>]*aria-pressed[^>]*disabled/);
  });

  test("does not confuse laptop and book poses at the same angle", () => {
    const html = renderToStaticMarkup(<HingeControls angle={90} onChange={onChange} />);
    expect(html).not.toContain('aria-pressed="true"');
    for (const pose of ["laptop", "book"] as const) {
      const posedHtml = renderToStaticMarkup(<HingeControls angle={90} pose={pose} onChange={onChange} />);
      expect(posedHtml.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(posedHtml).toMatch(new RegExp(`aria-label="${pose === "book" ? "Book" : "Laptop"}"[^>]*aria-pressed="true"`));
    }
  });

  test("allows unfolding while the display is folded", () => {
    const html = renderToStaticMarkup(<HingeControls angle={0} onChange={onChange} />);
    expect(html).toMatch(/aria-label="Closed"[^>]*aria-pressed="true"/);
    expect(html).not.toMatch(/<button[^>]*aria-pressed[^>]*disabled/);
  });

  test("does not infer a preset when the simulator explicitly reports a custom pose", () => {
    for (const angle of [0, 180]) {
      const html = renderToStaticMarkup(<HingeControls angle={angle} pose={null} onChange={onChange} />);
      expect(html).not.toContain('aria-pressed="true"');
    }
  });

  test("offers an accessible fine angle slider and a decimal degree input", () => {
    const html = renderToStaticMarkup(<HingeControls angle={42.5} onChange={onChange} />);
    expect(html).toMatch(/aria-label="Adjust hinge angle"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
    expect(html).toMatch(/type="range"[^>]*aria-label="Hinge angle"[^>]*min="0"[^>]*max="180"[^>]*step="1"[^>]*value="42.5"/);
    expect(html).toMatch(/type="number"[^>]*aria-label="Hinge angle in degrees"[^>]*min="0"[^>]*max="180"[^>]*step="any"[^>]*value="42.5"/);
  });

  test("keeps controls available while a previous update is pending", () => {
    const html = renderToStaticMarkup(<HingeControls angle={90} pose="laptop" tableModeAvailable pending onChange={onChange} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("disabled");
  });

  test("announces control errors", () => {
    const html = renderToStaticMarkup(<HingeControls supported error="Could not change hinge angle" onChange={onChange} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not change hinge angle");
  });

  test("makes Table Mode available only when the simulator supports it in the current pose", () => {
    const unavailable = renderToStaticMarkup(<HingeControls supported onChange={onChange} />);
    expect(unavailable).toContain('title="Table Mode is not available in the current pose"');
    expect(unavailable).toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]*disabled/);
    const available = renderToStaticMarkup(<HingeControls angle={80} pose="tent" tableMode tableModeAvailable onChange={onChange} />);
    expect(available).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Table Mode"/);
    expect(available).not.toContain("disabled");
  });

  test("allows turning Table Mode off after rotating into an ineligible pose", () => {
    const html = renderToStaticMarkup(<HingeControls supported tableMode tableModeAvailable={false} onChange={onChange} />);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Table Mode"/);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("Table Mode is not available");
  });
});
