import { expect, mock, test } from "bun:test";
import type { Camera } from "three";

// Drive the real scene's render/resize lifecycle. The renderer models the
// WebGL guarantee that changing canvas dimensions clears its drawing buffer.
class TestCanvas extends EventTarget {
  width = 300;
  height = 150;
  style = { cssText: "", width: "", height: "" };
  remove() {}
  getContext() { return { fillStyle: "", fillRect() {} }; }
}
class TestHost extends EventTarget {
  width = 480;
  height = 540;
  dataset: Record<string, string> = {};
  appendChild() {}
  getBoundingClientRect() { return { width: this.width, height: this.height }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  constructor(readonly callback: (entries: { contentRect: { width: number; height: number } }[]) => void) { observers.push(this); }
  observe() {}
  disconnect() {}
}
const testDocument = Object.assign(new EventTarget(), {
  hidden: false,
  createElement: () => new TestCanvas(),
});
const testWindow = Object.assign(new EventTarget(), {
  devicePixelRatio: 1,
  innerWidth: 1680,
  innerHeight: 1100,
  matchMedia: () => ({ matches: false }),
});
Object.assign(globalThis, {
  window: testWindow,
  document: testDocument,
  ResizeObserver: TestResizeObserver,
  ImageBitmap: class {},
});
const three = await import("three");
const renderers: TestRenderer[] = [];
class TestRenderer {
  domElement = new TestCanvas();
  framePresent = false;
  loop: ((now: number) => void) | null = null;
  renderCount = 0;
  resizeCount = 0;
  projectedHeight = 0;
  constructor() { renderers.push(this); }
  setPixelRatio() {}
  setSize(width: number, height: number) {
    this.domElement.width = width;
    this.domElement.height = height;
    this.framePresent = false;
    this.resizeCount++;
  }
  setAnimationLoop(loop: typeof this.loop) { this.loop = loop; }
  render(_scene: unknown, camera: Camera) {
    this.framePresent = true;
    this.renderCount++;
    camera.updateMatrixWorld();
    this.projectedHeight = new three.Vector3(0, 1, 0).project(camera).y * this.domElement.height;
  }
  dispose() {}
}
mock.module("three", () => ({
  ...three,
  WebGLRenderer: TestRenderer,
  PMREMGenerator: class {
    fromScene() { return { texture: new three.Texture(), dispose() {} }; }
    dispose() {}
  },
}));
mock.module("../../client/simulator/duo-model", () => ({
  async loadDuoModel() {
    const scene = new three.Group();
    for (const name of ["left-half", "right-half"]) {
      const half = new three.Group();
      half.name = name;
      scene.add(half);
    }
    return scene;
  },
}));
const { createDuoScene } = await import("../../client/simulator/duo-scene");

test("the resize handle changes projected model size inside a fixed, continuously drawn canvas", () => {
  const host = new TestHost();
  const scene = createDuoScene(
    host as unknown as HTMLElement,
    new TestHost() as unknown as HTMLElement,
    () => ({ angle: 180, pose: "open" }),
    { ready() {}, error: () => { throw new Error("Scene failed"); } },
  );
  const renderer = renderers.at(-1)!;
  const resize = observers.at(-1)!;
  const notifyStageResize = () => resize.callback([{ contentRect: host.getBoundingClientRect() }]);
  try {
    notifyStageResize();
    renderer.loop!(16);
    expect(renderer.framePresent).toBe(true);
    const projectedHeightPerStagePixel = renderer.projectedHeight / host.height;
    for (let frame = 1; frame <= 30; frame++) {
      // Browser ordering: rAF callbacks, layout, ResizeObserver, then paint.
      // The handle writes the new CSS width during the animation frame.
      renderer.loop!((frame + 1) * 16);
      expect(renderer.domElement.width).toBe(1680);
      expect(renderer.domElement.height).toBe(1100);
      expect(renderer.domElement.style.width).toBe("1680px");
      expect(renderer.domElement.style.height).toBe("1100px");
      expect(renderer.resizeCount).toBe(1);
      expect(renderer.projectedHeight / host.height).toBeCloseTo(projectedHeightPerStagePixel, 8);
      host.width += 4;
      host.height += 4.5;
      notifyStageResize();
      expect(renderer.framePresent).toBe(true);
    }
    renderer.loop!(32 * 16);
    expect(renderer.projectedHeight / host.height).toBeCloseTo(projectedHeightPerStagePixel, 8);
    expect(renderer.domElement.width).toBe(1680);
    expect(renderer.domElement.height).toBe(1100);
    const settledResizeCount = renderer.resizeCount;
    // Duplicate layout notifications must not allocate/clear another buffer.
    notifyStageResize();
    renderer.loop!(33 * 16);
    expect(renderer.resizeCount).toBe(settledResizeCount);
    expect(renderer.framePresent).toBe(true);

    // A window resize may reallocate, but only together with drawing. Model
    // size remains tied to the logical stage instead of the larger canvas.
    testWindow.innerWidth = 1440;
    testWindow.innerHeight = 900;
    testWindow.dispatchEvent(new Event("resize"));
    expect(renderer.resizeCount).toBe(1);
    expect(renderer.framePresent).toBe(true);
    renderer.loop!(34 * 16);
    expect(renderer.resizeCount).toBe(2);
    expect(renderer.domElement.width).toBe(1440);
    expect(renderer.domElement.height).toBe(900);
    expect(renderer.projectedHeight / host.height).toBeCloseTo(projectedHeightPerStagePixel, 8);
    expect(renderer.framePresent).toBe(true);
  } finally {
    scene.dispose();
    testWindow.innerWidth = 1680;
    testWindow.innerHeight = 1100;
    testWindow.dispatchEvent(new Event("resize"));
    expect(renderer.domElement.style.width).toBe("1440px");
  }
});
