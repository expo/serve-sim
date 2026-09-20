import { expect, mock, test } from "bun:test";
import type { DuoSceneState } from "../../client/simulator/duo-scene";

// The real scene chooses and uploads its textures. Only browser/GPU plumbing
// is replaced; frame content and individual texture writes remain observable.
class TestCanvas extends EventTarget {
  width = 300;
  height = 150;
  pixel = 0;
  draws = 0;
  style = { cssText: "", width: "", height: "" };
  remove() {}
  getContext() {
    return {
      fillStyle: "",
      fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
      drawImage: (source: TestCanvas) => { this.pixel = source.pixel; this.draws++; },
      getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(this.pixel) }),
    };
  }
}
class TestHost extends EventTarget {
  dataset: Record<string, string> = {};
  panels = new Map<number, TestHost>();
  source: TestCanvas | null = null;
  appendChild() {}
  getBoundingClientRect() { return { width: 480, height: 540 }; }
  querySelector(selector: string): TestHost | TestCanvas | null {
    const panel = selector.match(/^\[data-duo-panel="(1|3)"\]$/);
    if (panel) return this.panels.get(Number(panel[1])) ?? null;
    return selector === "canvas" ? this.source ?? this.panels.get(1)?.source ?? null : null;
  }
  querySelectorAll() { return []; }
}
const canvases: TestCanvas[] = [];
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), {
    devicePixelRatio: 1, innerWidth: 1680, innerHeight: 1100,
    matchMedia: () => ({ matches: false }),
  }),
  document: Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => { const canvas = new TestCanvas(); canvases.push(canvas); return canvas; },
  }),
  ResizeObserver: class { observe() {} disconnect() {} },
  HTMLCanvasElement: TestCanvas,
  HTMLVideoElement: class {},
  HTMLImageElement: class {},
  ImageBitmap: class {},
});
const three = await import("three");
const renderers: TestRenderer[] = [];
class TestRenderer {
  domElement = new TestCanvas();
  loop: ((now: number) => void) | null = null;
  constructor() { renderers.push(this); }
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop(loop: typeof this.loop) { this.loop = loop; }
  render() {}
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
mock.module("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    parseAsync() {
      const scene = new three.Group();
      for (const name of ["left-half", "right-half"]) {
        const half = new three.Group(); half.name = name; scene.add(half);
      }
      return Promise.resolve({ scene });
    }
  },
}));
const { createDuoScene } = await import("../../client/simulator/duo-scene");

function setup(dual: boolean) {
  const host = new TestHost();
  const sourceHost = new TestHost();
  const cover = Object.assign(new TestCanvas(), { width: 1398, height: 2034, pixel: 70 });
  const inner = Object.assign(new TestCanvas(), { width: 2007, height: 2853, pixel: 0 });
  if (dual) {
    sourceHost.panels.set(1, Object.assign(new TestHost(), { source: cover }));
    sourceHost.panels.set(3, Object.assign(new TestHost(), { source: inner }));
  } else sourceHost.source = cover;
  let state: DuoSceneState = {
    angle: 0, pose: "closed",
    streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait" },
  };
  const previous = canvases.length;
  const scene = createDuoScene(host as unknown as HTMLElement, sourceHost as unknown as HTMLElement,
    () => state, { ready() {}, error: () => { throw new Error("Scene failed"); } });
  const [innerTexture, coverTexture] = canvases.slice(previous);
  let now = 0;
  return {
    host, cover, inner, innerTexture: innerTexture!, coverTexture: coverTexture!,
    setState: (next: Partial<DuoSceneState>) => { state = { ...state, ...next }; },
    tick: (milliseconds = 16) => renderers.at(-1)!.loop!(now += milliseconds),
    dispose: () => scene.dispose(),
  };
}

test("inner frames appear before active metadata and provisional black cannot overwrite either panel", () => {
  const test = setup(true);
  try {
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    const coverDraws = test.coverTexture.draws;
    test.setState({ angle: 180, pose: "open" });
    test.cover.pixel = 0;
    test.tick();
    expect(test.innerTexture.draws).toBe(0);
    expect(test.coverTexture.draws).toBe(coverDraws);

    // The fixed inner feed becomes usable while main capture still reports
    // the cover. This must upload on this very animation frame.
    test.inner.pixel = 180;
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);
    expect(test.innerTexture.draws).toBe(1);
    expect(test.host.dataset.screenId).toBe("3");
    expect(test.host.dataset.screenReady).toBe("true");
    expect(test.coverTexture.pixel).toBe(70);

    test.inner.pixel = 0;
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);
    expect(test.innerTexture.draws).toBe(1);

    // A genuinely black active application frame is valid once election
    // confirms this panel, including a differently scaled main stream.
    test.setState({ streamConfig: { screenId: 3, width: 900, height: 1280, orientation: "landscape_left" } });
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    expect(test.innerTexture.draws).toBe(2);
    expect(test.coverTexture.pixel).toBe(70);

    test.setState({ angle: 0, pose: "closed" });
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    expect(test.coverTexture.draws).toBe(coverDraws);
  } finally { test.dispose(); }
});

test("the single-stream fallback still requires matching active display metadata", () => {
  const test = setup(false);
  try {
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    test.setState({ angle: 180, pose: "open" });
    test.tick();
    expect(test.innerTexture.draws).toBe(0);
    expect(test.host.dataset.screenId).toBe("1");
  } finally { test.dispose(); }
});

test("rapid reopening retains its cached screen while matching metadata belongs to the previous activation", () => {
  const test = setup(true);
  const innerConfig = { screenId: 3, width: 2007, height: 2853, orientation: "landscape_left" as const };
  try {
    test.tick();
    test.inner.pixel = 180;
    test.setState({ angle: 180, pose: "open", streamConfig: innerConfig });
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);

    // Close and reopen before the main metadata ever leaves screen 3.
    test.setState({ angle: 0, pose: "closed" });
    test.inner.pixel = 0;
    test.tick();
    test.setState({ angle: 180, pose: "open" });
    const beforeReopen = test.innerTexture.draws;
    for (let second = 0; second < 12; second++) {
      test.tick(1000);
      expect(test.innerTexture.pixel).toBe(180);
      expect(test.innerTexture.draws).toBe(beforeReopen);
    }
    expect(test.host.dataset.screenId).toBe("3");

    // A real black-to-valid frame transition proves this activation finished.
    // A subsequent genuinely black application frame must then be accepted.
    test.inner.pixel = 210;
    test.tick();
    expect(test.innerTexture.pixel).toBe(210);
    test.inner.pixel = 0;
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    expect(test.innerTexture.draws).toBe(beforeReopen + 2);

    test.inner.pixel = 230;
    test.tick();
    test.setState({ angle: 0, pose: "closed" });
    test.tick();
    test.setState({ angle: 180, pose: "open" });
    test.inner.pixel = 0;
    test.tick();
    expect(test.innerTexture.pixel).toBe(230);
    // A delayed metadata cycle is independent confirmation, even if the
    // newly active application has only black pixels.
    test.setState({ streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait" } });
    test.tick();
    expect(test.innerTexture.pixel).toBe(230);
    test.setState({ streamConfig: innerConfig });
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
  } finally { test.dispose(); }
});
