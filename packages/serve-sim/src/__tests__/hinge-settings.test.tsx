import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HingeSettings } from "../client/components/simulator-settings-tool";

const onChange = () => {};

describe("foldable simulator sidebar controls", () => {
  test("renders no rows without hinge capability or when explicitly unsupported", () => {
    expect(renderToStaticMarkup(<HingeSettings onChange={onChange} />)).toBe("");
    expect(renderToStaticMarkup(<HingeSettings supported={false} angle={90} onChange={onChange} />)).toBe("");
  });

  test("renders setting rows without a separate section or an assumed initial pose", () => {
    const html = renderToStaticMarkup(<HingeSettings supported onChange={onChange} />);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(Array.from(html.matchAll(/data-setting-row="([^"]+)"/g), ([, label]) => label)).toEqual([
      "Fold pose", "Hinge angle", "Table Mode",
    ]);
    expect(html).toMatch(/<button[^>]*aria-label="Fold pose"/);
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain(">Unknown<");
    expect(html).toContain('aria-valuetext="Unknown"');
    expect(html).toMatch(/type="number"[^>]*value=""/);
  });

  test("shows each named pose with the same labels as the toolbar and the extra table poses", () => {
    for (const [pose, label] of [
      ["closed", "Fully folded"],
      ["book", "Partially open"],
      ["open", "Fully open"],
      ["laptop", "Laptop"],
      ["tent", "Tent"],
    ] as const) {
      const html = renderToStaticMarkup(<HingeSettings angle={90} pose={pose} onChange={onChange} />);
      expect(html).toContain(`>${label}<`);
      expect(html).not.toContain(">Custom<");
      expect(html).not.toContain(">Unknown<");
    }
  });

  test("infers endpoint presets only if a pose has not been reported", () => {
    for (const [angle, label] of [[0, "Fully folded"], [180, "Fully open"]] as const) {
      const inferred = renderToStaticMarkup(<HingeSettings angle={angle} onChange={onChange} />);
      expect(inferred).toContain(`>${label}<`);
      const custom = renderToStaticMarkup(<HingeSettings angle={angle} pose={null} onChange={onChange} />);
      expect(custom).toContain(">Custom<");
    }
    const partial = renderToStaticMarkup(<HingeSettings angle={42.5} onChange={onChange} />);
    expect(partial).toContain(">Custom<");
  });

  test("offers an accessible fine angle slider and a decimal degree input directly in the settings rows", () => {
    const html = renderToStaticMarkup(<HingeSettings angle={42.5} onChange={onChange} />);
    const slider = html.match(/<input[^>]*aria-label="Hinge angle"[^>]*>/)?.[0];
    expect(slider).toBeDefined();
    for (const attribute of ['type="range"', 'min="0"', 'max="180"', 'step="1"', 'value="42.5"']) {
      expect(slider).toContain(attribute);
    }
    expect(html).toContain('aria-valuetext="42.5 degrees"');
    const degrees = html.match(/<input[^>]*aria-label="Hinge angle in degrees"[^>]*>/)?.[0];
    expect(degrees).toBeDefined();
    for (const attribute of ['type="number"', 'min="0"', 'max="180"', 'step="any"', 'value="42.5"']) {
      expect(degrees).toContain(attribute);
    }
    expect(html).not.toContain("Adjust hinge angle");
    expect(html).not.toContain('hidden=""');
  });

  test("keeps controls enabled while a previous update is pending", () => {
    const html = renderToStaticMarkup(<HingeSettings angle={90} pose="laptop" tableModeAvailable pending onChange={onChange} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/<(input|button)[^>]* disabled=""/);
  });

  test("announces control errors inside the sidebar", () => {
    const html = renderToStaticMarkup(<HingeSettings supported error="Could not change hinge angle" onChange={onChange} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not change hinge angle");
  });

  test("makes Table Mode available only when supported in the current pose", () => {
    const unavailable = renderToStaticMarkup(<HingeSettings supported onChange={onChange} />);
    expect(unavailable).toContain('title="Table Mode is not available in the current pose"');
    expect(unavailable).toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    const available = renderToStaticMarkup(<HingeSettings angle={80} pose="tent" tableMode tableModeAvailable onChange={onChange} />);
    expect(available).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Table Mode"/);
    expect(available).not.toMatch(/<button[^>]* disabled=""/);
  });

  test("allows turning Table Mode off after rotating into an ineligible pose", () => {
    const html = renderToStaticMarkup(<HingeSettings supported tableMode tableModeAvailable={false} onChange={onChange} />);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Table Mode"/);
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).not.toContain("Table Mode is not available");
  });
});
