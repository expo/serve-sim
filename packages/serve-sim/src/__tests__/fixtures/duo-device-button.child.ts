import { expect, mock, test } from "bun:test";
import type { ButtonHTMLAttributes, ReactElement } from "react";

// Exercise the component's event handlers and effect cleanup without a DOM.
const effects: Array<() => void | (() => void)> = [];
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
const testWindow = new EventTarget();
const testDocument = Object.assign(new EventTarget(), { hidden: false });
Object.assign(globalThis, { window: testWindow, document: testDocument });
const { DuoDeviceButton } = await import("../../client/components/duo-device-button");

function setup(disabled = false) {
  const phases: string[] = [];
  const element = DuoDeviceButton({ label: "Power", children: null, disabled, onPress: (phase) => phases.push(phase) }) as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  const captured = new Set<number>();
  const target = {
    focus() {},
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  };
  const cleanups = effects.splice(0).map((effect) => effect());
  type EventProps = { pointerId?: number; key?: string; detail?: number; button?: number };
  function fire(name: keyof ButtonHTMLAttributes<HTMLButtonElement>, values: EventProps = {}) {
    const handler = element.props[name] as ((event: unknown) => void) | undefined;
    handler?.({ currentTarget: target, button: 0, pointerId: 1, detail: 1, preventDefault() {}, stopPropagation() {}, ...values });
  }
  return { phases, captured, fire, dispose: () => { for (const cleanup of cleanups.splice(0)) cleanup?.(); } };
}

test("pointer press holds the native button until its own release, without a duplicate click", () => {
  const rig = setup();
  try {
    rig.fire("onPointerDown");
    rig.fire("onPointerDown", { pointerId: 2 });
    rig.fire("onPointerUp", { pointerId: 2 });
    expect(rig.phases).toEqual(["down"]);
    expect(rig.captured.has(1)).toBe(true);
    rig.fire("onPointerUp");
    rig.fire("onLostPointerCapture");
    rig.fire("onClick");
    expect(rig.phases).toEqual(["down", "up"]);
    expect(rig.captured.size).toBe(0);
  } finally { rig.dispose(); }
});

test("cancel, lost capture, blur, hidden page, and unmount each release a held button once", () => {
  for (const action of ["onPointerCancel", "onLostPointerCapture", "onBlur", "window-blur", "hidden", "unmount"] as const) {
    const rig = setup();
    try {
      rig.fire("onPointerDown");
      if (action === "window-blur") testWindow.dispatchEvent(new Event("blur"));
      else if (action === "hidden") { testDocument.hidden = true; testDocument.dispatchEvent(new Event("visibilitychange")); }
      else if (action === "unmount") rig.dispose();
      else rig.fire(action);
      rig.fire("onPointerUp");
      expect(rig.phases).toEqual(["down", "up"]);
      expect(rig.captured.size).toBe(0);
    } finally { rig.dispose(); testDocument.hidden = false; }
  }
});

test("keyboard and accessible activation send balanced presses and disabled controls send nothing", () => {
  for (const disabled of [false, true]) {
    const rig = setup(disabled);
    try {
      rig.fire("onKeyDown", { key: "Enter" });
      rig.fire("onKeyDown", { key: "Enter" });
      expect(rig.phases).toEqual(disabled ? [] : ["down"]);
      rig.fire("onKeyUp", { key: "Enter" });
      rig.fire("onClick", { detail: 0 });
      expect(rig.phases).toEqual(disabled ? [] : ["down", "up", "down", "up"]);
    } finally { rig.dispose(); }
  }
});
