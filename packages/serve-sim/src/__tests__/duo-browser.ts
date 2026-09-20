const frame = document.querySelector("iframe")!;
const output = document.querySelector("#results")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const params = new URL(location.href).searchParams;
const device = params.get("device");
const unsupportedDevice = params.get("unsupportedDevice");
if (!device) throw new Error("Pass ?device=<booted Duo UDID> to select the test simulator.");
frame.src = `/?device=${encodeURIComponent(device)}`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const results: string[] = [];
let unreadablePixel = "";
function check(condition: boolean, message: string) {
  results.push(`${condition ? "PASS" : "FAIL"} ${message}`);
  output.textContent = results.join("\n");
}
async function checkUnsupportedDevice() {
  if (!unsupportedDevice) return;
  frame.src = `/?device=${encodeURIComponent(unsupportedDevice)}`;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const doc = frame.contentDocument;
    const start = [...(doc?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((el) => el.textContent?.trim() === "Start");
    start?.click();
    if (doc?.querySelector('[data-stream-codec="webrtc"]')) {
      await delay(500);
      check(!doc.querySelector('[aria-label="Fold position"]'), "A device without native hinge support has no fold controls");
      return;
    }
    await delay(100);
  }
  check(false, "A device without native hinge support becomes ready for the controls check");
}
function liveScreen(doc: Document): HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | undefined {
  return [...doc.querySelectorAll<HTMLCanvasElement | HTMLImageElement | HTMLVideoElement>('[data-fold-leaf="right"] [data-devicekit-screen] canvas, [data-fold-leaf="right"] [data-devicekit-screen] img, [data-fold-leaf="right"] [data-devicekit-screen] video')]
    .find((element) => getComputedStyle(element).display !== "none");
}
function button(doc: Document, name: string) {
  const found = [...doc.querySelectorAll<HTMLButtonElement>("button")]
    .find((el) => el.textContent?.trim() === name || el.getAttribute("aria-label") === name);
  if (!found) throw new Error(`Missing ${name} button`);
  return found;
}
type LoggedEvent = { id: number; kind: string; action?: string; status?: string };
async function readEvents(): Promise<LoggedEvent[]> {
  const response = await fetch(`/api/event-log?device=${encodeURIComponent(device!)}&limit=20`);
  return (await response.json() as { events: LoggedEvent[] }).events;
}
async function waitForEvent(after: number, predicate: (event: LoggedEvent) => boolean) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const event = (await readEvents()).find((candidate) => candidate.id > after && predicate(candidate));
    if (event) return event;
    await delay(50);
  }
}
async function sendOrientation(orientation: string) {
  const preview = (frame.contentWindow as Window & { __SIM_PREVIEW__?: { wsUrl?: string } }).__SIM_PREVIEW__;
  if (!preview?.wsUrl) throw new Error("Duo preview did not expose its control socket");
  const socket = new WebSocket(preview.wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("Duo control socket did not open"));
  });
  const payload = new TextEncoder().encode(JSON.stringify({ orientation }));
  const message = new Uint8Array(payload.length + 1);
  message[0] = 0x07;
  message.set(payload, 1);
  socket.send(message);
  await delay(100);
  socket.close();
}
async function setPortrait() {
  await sendOrientation("landscape_right");
  await delay(500);
  await sendOrientation("portrait");
  await delay(1000);
}
async function checkRotation(doc: Document) {
  const cycle: Record<string, string> = {
    landscape_left: "portrait",
    portrait: "landscape_right",
    landscape_right: "portrait_upside_down",
    portrait_upside_down: "landscape_left",
  };
  let lastId = Math.max(0, ...(await readEvents()).map((event) => event.id));
  const actions: string[] = [];
  const stage = doc.querySelector<HTMLElement>("[data-fold-stage]")!;
  const before = stage.getBoundingClientRect();
  for (let index = 0; index < 4; index++) {
    button(doc, "Rotate device").click();
    const event = await waitForEvent(lastId, (candidate) => candidate.kind === "rotate");
    check(!!event, `Rotation ${index + 1}: native Duo orientation command succeeds`);
    if (!event?.action) return;
    lastId = event.id;
    actions.push(event.action);
    if (index === 0) {
      await delay(700);
      const rotated = stage.getBoundingClientRect();
      check(rotated.height > rotated.width && before.width > before.height, "Duo visibly rotates from landscape to portrait");
    }
  }
  check(actions.every((action, index) => index === 0 || action === cycle[actions[index - 1]!]), `Duo rotates through four distinct orientations (${actions.join(" → ")})`);
  await delay(700);
  const after = stage.getBoundingClientRect();
  check(Math.abs(after.width - before.width) < 1 && Math.abs(after.height - before.height) < 1, "Duo rotation preserves the physical fold geometry");
  await delay(1800);
}
async function checkHome(doc: Document) {
  const lastId = Math.max(0, ...(await readEvents()).map((event) => event.id));
  button(doc, "Home").click();
  const home = await waitForEvent(lastId, (event) => event.kind === "button" && event.action === "home");
  check(home?.status === "ok", "Home returns the Duo to SpringBoard");
}
async function ready(): Promise<Document> {
  const deadline = performance.now() + 30000;
  let started = false;
  while (performance.now() < deadline) {
    const doc = frame.contentDocument;
    if (!doc) { await delay(100); continue; }
    const start = [...doc.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === "Start");
    if (start && !started) { started = true; start.click(); }
    if (liveScreen(doc) &&
        [...doc.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Half Fold")) return doc;
    await delay(100);
  }
  throw new Error("Live Duo preview did not become ready. Start the selected simulator in the preview first.");
}
function edgeHeight(doc: Document, leaf: HTMLElement, x: string) {
  const points = ["0", "100%"].map((y) => {
    const point = doc.createElement("span");
    Object.assign(point.style, { position: "absolute", left: x, top: y, width: "0", height: "0" });
    leaf.append(point);
    return point;
  });
  const height = Math.abs(points[1]!.getBoundingClientRect().y - points[0]!.getBoundingClientRect().y);
  points.forEach((point) => point.remove());
  return height;
}
function lit(source: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement) {
  const sample = document.createElement("canvas");
  sample.width = sample.height = 8;
  const context = sample.getContext("2d")!;
  context.drawImage(source, 0, 0, 8, 8);
  const pixels = context.getImageData(0, 0, 8, 8).data;
  return pixels.some((value, index) => index % 4 !== 3 && value > 40);
}

function matrix(transform: string) {
  return transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
}


function sampleVisibleFaces(doc: Document) {
  return [...doc.querySelectorAll<HTMLElement>('[data-fold-front], [data-fold-door-back]')]
    .filter(face => doc.defaultView!.getComputedStyle(face).visibility === "visible" && face.getBoundingClientRect().width >= 5)
    .map(face => {
      const canvas = face.querySelector<HTMLCanvasElement>('canvas[data-stream-codec="webrtc"]');
      return { face, lit: !!canvas && lit(canvas) };
    });
}

function coverEdgeLeaks(doc: Document): number {
  const cover = doc.querySelector<HTMLElement>("[data-fold-door-back]");
  if (!cover || doc.defaultView!.getComputedStyle(cover).visibility !== "visible" || cover.getBoundingClientRect().width < 15) return 0;
  let leaks = 0;
  for (const y of [0.25, 0.5, 0.75]) {
    const probe = doc.createElement("span");
    Object.assign(probe.style, { position: "absolute", left: "2px", top: `${y * 100}%`, width: "0", height: "0", pointerEvents: "none" });
    cover.append(probe);
    const point = probe.getBoundingClientRect();
    const top = doc.elementFromPoint(point.x, point.y);
    const inner = '[data-duo-panel="inner"], [data-fold-leaf="right"] [data-devicekit-screen]';
    if (top?.closest(inner) || (top?.matches('[data-fold-leaf="left"]')
      && doc.elementsFromPoint(point.x, point.y).some(element => element.closest(inner)))) leaks++;
    probe.remove();
  }
  return leaks;
}

function fixtureCounter(doc: Document, side: "left" | "right" | "cover", row = 0): number | null {
  const selector = side === "cover" ? "[data-fold-door-back] [data-stream-codec]" : `[data-fold-leaf="${side}"] [data-fold-front] [data-devicekit-screen] canvas, [data-fold-leaf="${side}"] [data-fold-front] [data-devicekit-screen] img, [data-fold-leaf="${side}"] [data-fold-front] [data-devicekit-screen] video`;
  const source = [...doc.querySelectorAll<HTMLCanvasElement | HTMLImageElement | HTMLVideoElement>(selector)]
    .find((el) => getComputedStyle(el).display !== "none");
  if (!source) return null;
  const sample = document.createElement("canvas");
  sample.width = 200; sample.height = 100;
  const ctx = sample.getContext("2d")!;
  const width = source.tagName === "VIDEO" ? (source as HTMLVideoElement).videoWidth : source.tagName === "CANVAS" ? (source as HTMLCanvasElement).width : (source as HTMLImageElement).naturalWidth;
  const height = source.tagName === "VIDEO" ? (source as HTMLVideoElement).videoHeight : source.tagName === "CANVAS" ? (source as HTMLCanvasElement).height : (source as HTMLImageElement).naturalHeight;
  if (width < height && side !== "cover") {
    ctx.translate(200, 0); ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, 0, 0, 100, 200);
  } else ctx.drawImage(source, 0, 0, 200, 100);
  let counter = 0;
  for (let bit = 0; bit < 8; bit++) {
    const x = Math.round(((side === "right" ? 0.5 : 0) + 0.07 + bit * 0.05) * 200);
    const pixel = ctx.getImageData(x, 26 + row * 24, 1, 1).data;
    if (pixel[0]! > 210 && pixel[1]! > 210 && pixel[2]! > 210) counter |= 1 << bit;
    else if (pixel[0]! > 55 || pixel[1]! > 55 || pixel[2]! > 55) {
      unreadablePixel = `${side} bit${bit} rgb=${[...pixel].slice(0, 3).join(",")} source=${width}x${height}`;
      return null;
    }
  }
  return counter;
}
function nativeShadow(doc: Document): number {
  const source = doc.querySelector<HTMLCanvasElement>('[data-fold-leaf="right"] [data-stream-codec="webrtc"]');
  if (!source?.width) return 0;
  const sample = document.createElement("canvas"); sample.width = 200; sample.height = 100;
  const context = sample.getContext("2d")!;
  context.translate(200, 0); context.rotate(Math.PI / 2); context.drawImage(source, 0, 0, 100, 200);
  let difference = 0;
  for (let bit = 0; bit < 8; bit++) {
    const left = context.getImageData(14 + bit * 10, 26, 1, 1).data;
    const right = context.getImageData(114 + bit * 10, 26, 1, 1).data;
    difference += (Math.abs(left[0]! - right[0]!) + Math.abs(left[1]! - right[1]!) + Math.abs(left[2]! - right[2]!)) / 3;
  }
  return difference / 8;
}
async function sampleHalves(doc: Document) {
  const seen = { left: new Set<number>(), right: new Set<number>() };
  let mismatches = 0;
  const mismatchValues: string[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => doc.defaultView!.requestAnimationFrame(() => resolve()));
    const left = fixtureCounter(doc, "left");
    const right = fixtureCounter(doc, "right");
    if (left !== null) seen.left.add(left);
    if (right !== null) seen.right.add(right);
    if (left === null || right === null || left !== right) { mismatches++; mismatchValues.push(`${left}/${right}${left === null || right === null ? ` (${unreadablePixel})` : ""}`); }
    await delay(100);
  }
  return { left: seen.left.size, right: seen.right.size, mismatches, mismatchValues };
}
async function checkFreshHalves(doc: Document, pose: string) {
  const started = performance.now();
  const deadline = started + 8000;
  const advances = new Set<number>();
  while (performance.now() < deadline && advances.size < 3) {
    const left = fixtureCounter(doc, "left"), right = fixtureCounter(doc, "right");
    if (left !== null && left === right) advances.add(left);
    else advances.clear();
    await delay(50);
  }
  check(advances.size >= 3, `${pose}: fresh native fixture ready within ${Math.round(performance.now() - started)}ms (8s limit)`);
  if (advances.size < 3) throw new Error(`${pose}: native display did not become live (${unreadablePixel}); preserving the failed pose for inspection`);
  const sample = await sampleHalves(doc);
  check(sample.left >= 4 && sample.right >= 4,
    `${pose}: both visible halves advance (left ${sample.left}, right ${sample.right} frames; codec ${liveScreen(doc)?.getAttribute("data-stream-codec")})`);
  check(sample.mismatches <= 1, `${pose}: halves show the same fixture frame (${sample.mismatches}/20 mismatches: ${sample.mismatchValues.join(",")})`);
}
async function checkInput(doc: Document, cover = false) {
  for (const side of (cover ? ["cover"] : ["left", "right"]) as ("left" | "right" | "cover")[]) {
    const readCounter = async (expected?: number) => {
      const deadline = performance.now() + 3000;
      let stable: number | null = null;
      let samples = 0;
      while (performance.now() < deadline) {
        const value = fixtureCounter(doc, side, 1);
        if (value !== null && (expected === undefined || value === expected)) {
          samples = value === stable ? samples + 1 : 1;
          stable = value;
          if (samples === 3) return value;
        } else {
          stable = null;
          samples = 0;
        }
        await delay(50);
      }
      return stable;
    };
    const before = await readCounter();
    const leaf = doc.querySelector<HTMLElement>(side === "cover" ? "[data-fold-door-back]" : `[data-fold-leaf="${side}"]`)!;
    const rect = leaf.getBoundingClientRect();
    const x = rect.left + rect.width * (cover ? 0.25 : 0.5), y = rect.top + rect.height * 0.6;
    const input = doc.elementFromPoint(x, y);
    check(!!input?.hasAttribute("data-simulator-input"), `${side}: composed visible face receives input`);
    input?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, buttons: 1 }));
    await delay(60);
    input?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    const after = await readCounter(before === null ? undefined : (before + 1) % 256);
    check(before !== null && after === (before + 1) % 256, `${side}: tap changes real simulator counter (${before} → ${after})`);
  }
}
async function checkSlider(doc: Document) {
  check(doc.querySelectorAll('[aria-label="Fold position"] button').length === 4, "Four fold controls are visible");
  button(doc, "Angle").click();
  await delay(50);
  const slider = doc.querySelector<HTMLInputElement>('input[aria-label="Hinge angle"]');
  if (!slider) throw new Error("Fourth control did not open its slider");
  const controls = doc.querySelector<HTMLElement>('[aria-label="Fold position"]')!.getBoundingClientRect();
  const sliderPanel = doc.querySelector<HTMLElement>('[data-hinge-angle-panel]')!.getBoundingClientRect();
  check(sliderPanel.top >= controls.bottom, "Angle slider opens below the fold controls");
  check(sliderPanel.height <= 60, "Angle slider stays compact");
  check(slider.min === "0" && slider.max === "180" && slider.step === "1", "Slider exposes the full continuous range");
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(slider), "value")!.set!;
  const settle = async () => {
    const deadline = performance.now() + 8000;
    do { await delay(100); } while ((doc.querySelector('[aria-label="Fold position"]')?.getAttribute("aria-busy") === "true" || doc.querySelector<HTMLElement>("[data-fold-stage]")?.dataset.duoPhase !== "idle") && performance.now() < deadline);
  };
  for (const angle of [0, 30, 45, 51, 54, 55, 71, 90, 120, 150, 180]) {
    setValue.call(slider, String(angle)); slider.dispatchEvent(new Event("input", { bubbles: true }));
    await delay(50);
    await settle();
    if (angle < 50) {
      const cover = doc.querySelector<HTMLElement>("[data-fold-cover-content]")!;
      check(Number(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-dark]")!).opacity) === 0, `Slider: outer LCD remains visible at ${angle}°`);
      check(getComputedStyle(cover).filter === "none", `Slider: native outer LCD effect has no added CSS blur at ${angle}°`);
    }
    check(Number(slider.value) === angle && doc.querySelector('[aria-label="Fold position"]')?.getAttribute("aria-busy") === "false", `Slider settles at confirmed ${angle}°`);
    const coverDark = Number(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-dark]")!).opacity);
    const coverFilter = getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-content]")!).filter;
    if (angle === 0) check(coverDark === 0 && coverFilter === "none", "Slider: settled outer LCD is sharp and visible at 0°");
    if (angle === 30) check(coverDark === 0 && coverFilter === "none", "Slider: stopped outer LCD is sharp at 30°");
    if (angle === 45 || angle === 51 || angle === 54) {
      check(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-door-back]")!).visibility === "visible", `Slider: Device Hub retains the outer display at ${angle}°`);
      check([...doc.querySelectorAll<HTMLElement>("[data-fold-front]")].every((front) => getComputedStyle(front).visibility === "hidden"), `Slider: Device Hub hides both inner leaves at ${angle}°`);
      const single = matrix(getComputedStyle(doc.querySelector<HTMLElement>('[data-fold-leaf="left"]')!).transform);
      check(Math.abs(single.m11) > 0.89, `Slider: ${angle}° keeps Device Hub's mostly frontal single-device silhouette`);
    }
    if (angle === 55 || angle === 71) {
      const [left, right] = [...doc.querySelectorAll<HTMLElement>("[data-fold-leaf]")]
        .map((leaf) => matrix(getComputedStyle(leaf).transform));
      check(Math.abs(Math.abs(left!.m13) - Math.abs(right!.m13)) < 0.002
        && Math.abs(left!.m11 - right!.m11) < 0.002,
      `Slider: ${angle}° uses Device Hub's symmetric inner-book geometry`);
    }
  }
  setValue.call(slider, "53"); slider.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(50);
  const closingTo53 = Number(doc.querySelector<HTMLElement>("[data-fold-angle]")?.dataset.foldAngle);
  check(closingTo53 > 53 && closingTo53 < 180, `Slider: Unfold → 53° animates through the closing geometry (${closingTo53.toFixed(1)}° after 50ms)`);
  check(!doc.querySelector("[data-fold-crease]") && [...doc.querySelectorAll<HTMLElement>("[data-fold-front]")].every(front => getComputedStyle(front).filter === "none"), "Slider: animated close has no synthetic center line or leaf shadow");
  await settle();
  check(Number(doc.querySelector<HTMLElement>("[data-fold-angle]")?.dataset.foldAngle) === 53, "Slider: animated close settles at 53°");
  check(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-door-back]")!).visibility === "visible", "Slider: animated close at 53° settles on the single outer display");
  setValue.call(slider, "44"); slider.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(50);
  const closingTo44 = Number(doc.querySelector<HTMLElement>("[data-fold-angle]")?.dataset.foldAngle);
  check(closingTo44 > 44 && closingTo44 <= 53, `Slider: 53° → 44° continues the close without snapping (${closingTo44.toFixed(1)}° after 50ms)`);
  await settle();
  setValue.call(slider, "180"); slider.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  for (const angle of [54, 46]) {
    setValue.call(slider, String(angle)); slider.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    check(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-door-back]")!).visibility === "visible", `Slider closing: Device Hub uses the single outer display at ${angle}°`);
    check([...doc.querySelectorAll<HTMLElement>("[data-fold-front]")].every((front) => getComputedStyle(front).visibility === "hidden"), `Slider closing: inner leaves are hidden at ${angle}°`);
  }
  setValue.call(slider, "45"); slider.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  check(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-door-back]")!).visibility === "visible", "Slider closing: Device Hub returns to the outer display at 45°");
  let boundaryBlackFaces = 0;
  let boundaryCoverFrames = 0;
  for (const angle of [44, 45, 44, 45, 44, 45]) {
    setValue.call(slider, String(angle)); slider.dispatchEvent(new Event("input", { bubbles: true }));
    await delay(50);
    boundaryBlackFaces += sampleVisibleFaces(doc).filter(face => !face.lit).length;
    boundaryCoverFrames += getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-door-back]")!).visibility === "visible" ? 1 : 0;
  }
  check(boundaryBlackFaces === 0, `Slider: 44°/45° handoff has no black flick (${boundaryBlackFaces} black samples)`);
  check(boundaryCoverFrames === 6, `Slider: 44°/45° handoff retains the outer face across all samples (${boundaryCoverFrames}/6)`);
  let animatedTrackingSamples = 0;
  let outOfRangeSamples = 0;
  const tracking: string[] = [];
  let blackSliderFaces = 0;
  let syntheticBlurFrames = 0;
  for (const angle of [150, 120, 90, 70, 40, 15, 6, 15, 40, 70, 90, 120, 150, 180]) {
    setValue.call(slider, String(angle)); slider.dispatchEvent(new Event("input", { bubbles: true }));
    await delay(50);
    const presented = Number(doc.querySelector<HTMLElement>("[data-fold-angle]")?.dataset.foldAngle);
    const blackFaces = sampleVisibleFaces(doc).filter(face => !face.lit);
    blackSliderFaces += blackFaces.length;
    const cover = doc.querySelector<HTMLElement>("[data-fold-door-back]");
    const content = doc.querySelector<HTMLElement>("[data-fold-cover-content]");
    if (angle > 0 && cover && getComputedStyle(cover).visibility === "visible" && getComputedStyle(content!).filter !== "none") syntheticBlurFrames++;
    tracking.push(`${angle}→${presented} ${doc.querySelector<HTMLElement>("[data-fold-stage]")?.dataset.duoPhase}`);
    animatedTrackingSamples += Math.abs(presented - angle) > 1 ? 1 : 0;
    outOfRangeSamples += presented < 0 || presented > 180 ? 1 : 0;
  }
  await settle();
  check(animatedTrackingSamples > 0 && outOfRangeSamples === 0 && Number(doc.querySelector<HTMLElement>("[data-fold-angle]")?.dataset.foldAngle) === 180, `Slider follows rapid input with bounded interruptible motion (${tracking.join(", ")})`);
  check(blackSliderFaces === 0, `Slider keeps decoded WebRTC frames visible through rapid reversals (${blackSliderFaces} black samples)`);
  check(syntheticBlurFrames === 0, `Slider uses only native LCD effects (${syntheticBlurFrames} CSS-blurred samples)`);
  setValue.call(slider, "22"); slider.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(50);
  check(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-content]")!).filter === "none", "Slider: moving outer LCD uses no CSS blur at 22°");
  await delay(200);
  check(getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-content]")!).filter === "none", "Slider: stopped outer LCD uses no CSS blur at 22°");
  setValue.call(slider, "6"); slider.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(2000);
  check(coverEdgeLeaks(doc) === 0, "Near-closed slider pose has no exposed inner LCD beside the cover chrome");
  const shell = doc.querySelector<HTMLElement>("[data-fold-cover-shell]")!;
  check(!!shell && !getComputedStyle(shell).backgroundColor.startsWith("rgba") && getComputedStyle(shell).opacity === "1", "Cover hinge has an opaque physical backing");
  for (const angle of [10, 170, 30, 150, 70, 120]) {
    setValue.call(slider, String(angle)); slider.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await delay(2000);
  check(Number(slider.value) === 120 && doc.querySelector('[aria-label="Fold position"]')?.getAttribute("aria-busy") === "false", "Rapid reversal retains the final slider angle");
  slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await delay(50);
  check(!doc.querySelector('input[aria-label="Hinge angle"]') && doc.activeElement === button(doc, "Angle"), "Escape closes the slider and restores focus");
  button(doc, "Unfold").click(); await delay(1800);
  check(button(doc, "Unfold").getAttribute("aria-pressed") === "true", "Presets work after dragging the slider");
}

function checkWebRtc(doc: Document) {
  const videos = [...doc.querySelectorAll<HTMLVideoElement>('video[data-duo-webrtc-source]')];
  const tracks = videos.map(video => (video.srcObject as MediaStream | null)?.getVideoTracks()[0]);
  check(videos.length === 1 && doc.querySelectorAll('canvas[data-stream-codec="webrtc"]').length === 3 && tracks.every(track => track?.readyState === "live"), "All three physical faces share one live WebRTC source video");
  check(new Set(tracks.map(track => track?.id)).size === 1, "All faces share one WebRTC video track");
  check(!doc.querySelector('canvas[data-stream-codec]:not([data-stream-codec="webrtc"])'), "Duo has not fallen back to HTTP decoding");
}

async function checkMotionPreferences(doc: Document) {
  const win = frame.contentWindow!;
  const angle = () => Number(doc.querySelector<HTMLElement>("[data-fold-angle]")?.dataset.foldAngle);
  button(doc, "Fold").click();
  await delay(100);
  const before = angle();
  button(doc, "Unfold").click();
  await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  check(before > 0 && before < 180 && Math.abs(angle() - before) < 45, "Interrupted fold resumes from its current visual angle without snapping");
  await delay(1800);
  const matchMedia = win.matchMedia;
  try {
    win.matchMedia = (query) => {
      const result = matchMedia.call(win, query);
      if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
    button(doc, "Fold").click();
    await delay(100);
    check(angle() === 0, "Reduced motion settles Fold immediately");
    button(doc, "Unfold").click();
    await delay(100);
    check(angle() === 180, "Reduced motion settles Unfold immediately");
  } finally { win.matchMedia = matchMedia; }
  await delay(1800);
  await checkFreshHalves(doc, "After motion interruption");
}

run.onclick = async () => {
  sliderRun.disabled = run.disabled = true;
  results.length = 0;
  output.textContent = "Running…";
  try {
    let doc = await ready();
    check(!!doc.querySelector('[aria-label="Fold position"]'), "Native hinge support exposes the fold controls");
    button(doc, "Fold").click();
    await delay(3500);
    await setPortrait();
    frame.contentWindow!.location.reload();
    await delay(500);
    doc = await ready();
    const coverStartedAt = performance.now();
    const coverDeadline = coverStartedAt + 15000;
    const coverFrames = new Set<number>();
    while (performance.now() < coverDeadline && coverFrames.size < 3) {
      const cover = doc.querySelector<HTMLCanvasElement>('[data-duo-panel="cover"] canvas[data-stream-codec="webrtc"]');
      const counter = fixtureCounter(doc, "cover");
      if (cover && lit(cover) && counter !== null) coverFrames.add(counter);
      await delay(50);
    }
    check(coverFrames.size >= 3, `Cold connection receives a live cover in ${Math.round(performance.now() - coverStartedAt)}ms`);
    if (coverFrames.size < 3) throw new Error("WebRTC cover did not become live after reload");
    const win = frame.contentWindow!;
    for (const name of ["Close devices sidebar", "Close panel"]) {
      const close = doc.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
      close?.click();
    }
    checkWebRtc(doc);
    const coldInner = doc.querySelector<HTMLCanvasElement>('[data-duo-panel="inner"] canvas[data-stream-codec="webrtc"]');
    check(!coldInner?.dataset.duoFrameAt, "Cold folded connection has no cached inner frame");
    const referenceHeight = doc.querySelector('[data-fold-stage]')!.getBoundingClientRect().height;
    for (const pose of ["Unfold", "Half Fold", "Fold", "Unfold", "Fold", "Half Fold", "Unfold"]) {
      const initial = [...doc.querySelectorAll('[data-devicekit-screen] canvas, [data-devicekit-screen] img, [data-devicekit-screen] video')];
      const panelCanvases = [...doc.querySelectorAll<HTMLCanvasElement>('[data-stream-codec="webrtc"]')];
      const panelLayouts = panelCanvases.map(canvas => [canvas.style.width, canvas.style.height, canvas.style.transform].join("|"));
      let panelLayoutChanged = false;
      let detached = false;
      let rotated = false;
      let empty = false;
      let foldsAway = false;
      let unreadableInnerFrames = 0;
      let transitionPixel = "";
      let splitInnerFrames = 0;
      const innerTransition = button(doc, "Half Fold").getAttribute("aria-pressed") === "true" && pose === "Unfold";
      const destinationPanel = pose === "Fold" ? "cover" : "inner";
      const destinationCanvas = doc.querySelector<HTMLCanvasElement>(`[data-duo-panel="${destinationPanel}"] canvas[data-stream-codec="webrtc"]`);
      const cachedDestination = !!destinationCanvas && lit(destinationCanvas);
      const opening = doc.querySelector('[data-fold-layout="cover"]') !== null;
      let frames = 0;
      let maxHeightStep = 0;
      let maxNativeShadow = 0, finalNativeShadow = 0, maxCenterExcursion = 0;
      let motionSettledAt = 0, coverTurnAt = 0;
      let motionStartedAt = 0, blackVisibleFrames = 0, blankStageFrames = 0, movingFrames = 0;
      let innerMidpointAt = 0, innerAsymmetry = 0, innerReversal = false;
      const blackDetails: string[] = [];
      let rightLeafDetour = 0, coverVisibleFrames = 0, litCoverFrames = 0;
      let closingCoverFrames = 0, darkClosingCoverFrames = 0, syntheticBlurFrames = 0;
      let darkOpeningInnerFrames = 0;
      let leakedCoverEdges = 0;
      const initialAngle = Number(doc.querySelector<HTMLElement>('[data-fold-angle]')!.dataset.foldAngle);
      const directCoverOpen = (initialAngle === 180 && pose === "Fold") || (initialAngle === 0 && pose === "Unfold");
      const targetAngle = pose === "Fold" ? 0 : pose === "Half Fold" ? 90 : 180;
      let previousAngle = initialAngle;
      let previousHeight = doc.querySelector('[data-fold-leaf="right"]')!.getBoundingClientRect().height;
      const started = performance.now();
      const end = started + 8000;
      button(doc, pose).click();
      await new Promise<void>((resolve) => {
        const sample = () => {
          frames++;
          leakedCoverEdges += coverEdgeLeaks(doc);
          panelLayoutChanged ||= panelCanvases.some((canvas, i) => [canvas.style.width, canvas.style.height, canvas.style.transform].join("|") !== panelLayouts[i]);
          if (innerTransition) {
            const left = fixtureCounter(doc, "left"), right = fixtureCounter(doc, "right");
            if (left === null || right === null) { unreadableInnerFrames++; transitionPixel ||= unreadablePixel; }
            else if (left !== right) splitInnerFrames++;
          }
          const stageElement = doc.querySelector<HTMLElement>('[data-fold-stage]')!;
          const stage = stageElement.getBoundingClientRect();
          if (stageElement.dataset.duoPhase === "moving") {
            motionStartedAt ||= performance.now();
            movingFrames++;
            if (opening) {
              const innerContent = doc.querySelector<HTMLElement>("[data-fold-inner-content]");
              const innerDark = doc.querySelector<HTMLElement>("[data-fold-inner-dark]");
              if (innerContent && win.getComputedStyle(innerContent).filter !== "none") syntheticBlurFrames++;
              if (innerDark && Number(win.getComputedStyle(innerDark).opacity) > 0.99) darkOpeningInnerFrames++;
            }
          }
          const presentedFaces = sampleVisibleFaces(doc);
          if (!presentedFaces.length) blankStageFrames++;
          for (const { face, lit: isLit } of presentedFaces) {
            if (!isLit) {
              blackVisibleFrames++;
              if (blackDetails.length < 8) blackDetails.push(`${Math.round(performance.now() - started)}ms ${stageElement.dataset.duoPhase} ${face.hasAttribute("data-fold-door-back") ? "cover" : face.closest("[data-fold-leaf]")?.getAttribute("data-fold-leaf")}`);
            }
            if (opening && face.hasAttribute("data-fold-door-back")) {
              coverVisibleFrames++;
              if (isLit) litCoverFrames++;
            }
            if (pose === "Fold" && stageElement.dataset.duoPhase === "moving" && face.hasAttribute("data-fold-door-back")) {
              closingCoverFrames++;
              const dark = face.querySelector<HTMLElement>("[data-fold-cover-dark]");
              if (dark && Number(win.getComputedStyle(dark).opacity) > 0.99) darkClosingCoverFrames++;
              const content = face.querySelector<HTMLElement>("[data-fold-cover-content]");
              if (content && win.getComputedStyle(content).filter !== "none") syntheticBlurFrames++;
            }
          }
          if (directCoverOpen) {
            const right = doc.querySelector<HTMLElement>('[data-fold-leaf="right"]')!;
            rightLeafDetour = Math.max(rightLeafDetour, Math.abs(matrix(win.getComputedStyle(right).transform).m13));
          }
          finalNativeShadow = nativeShadow(doc);
          maxNativeShadow = Math.max(maxNativeShadow, finalNativeShadow);
          const visibleFaces = [...doc.querySelectorAll<HTMLElement>('[data-fold-front], [data-fold-door-back]')]
            .filter(face => win.getComputedStyle(face).visibility === "visible").map(face => face.getBoundingClientRect());
          if (visibleFaces.length) {
            const center = (Math.min(...visibleFaces.map(r => r.left)) + Math.max(...visibleFaces.map(r => r.right))) / 2;
            maxCenterExcursion = Math.max(maxCenterExcursion, (center - (stage.left + stage.width / 2)) / stage.width);
          }
          const visualAngle = Number(doc.querySelector<HTMLElement>('[data-fold-angle]')!.dataset.foldAngle);
          if (innerTransition) {
            const left = matrix(win.getComputedStyle(doc.querySelector<HTMLElement>('[data-fold-leaf="left"]')!).transform);
            const right = matrix(win.getComputedStyle(doc.querySelector<HTMLElement>('[data-fold-leaf="right"]')!).transform);
            innerAsymmetry = Math.max(innerAsymmetry, Math.abs(left.m13 + right.m13));
            innerReversal ||= visualAngle + 0.01 < previousAngle;
            if (!innerMidpointAt && visualAngle >= 135) innerMidpointAt = performance.now() - (motionStartedAt || started);
            previousAngle = visualAngle;
          }
          if (pose === "Fold" && !coverTurnAt && win.getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-door-back]")!).visibility === "visible") coverTurnAt = performance.now() - (motionStartedAt || started);
          if (!motionSettledAt && Math.abs(visualAngle - targetAngle) < 0.1) motionSettledAt = performance.now() - (motionStartedAt || started);
          const height = doc.querySelector('[data-fold-leaf="right"]')!.getBoundingClientRect().height;
          maxHeightStep = Math.max(maxHeightStep, Math.abs(height - previousHeight) / previousHeight);
          previousHeight = height;
          detached ||= initial.some((canvas) => !canvas.isConnected);
          const root = doc.querySelector<HTMLElement>("[data-fold-layout]");
          const leaf = doc.querySelector<HTMLElement>('[data-fold-leaf="left"]')!;
          const leafTransform = win.getComputedStyle(leaf).transform;
          if (root?.dataset.foldLayout === "book" && leafTransform !== "none") {
            foldsAway ||= matrix(leafTransform).m13 > 0.01;
          }
          empty ||= !liveScreen(doc);
          for (let el = root?.parentElement; el; el = el.parentElement) {
            const transform = win.getComputedStyle(el).transform;
            if (transform !== "none") {
              const matrix = new DOMMatrixReadOnly(transform);
              rotated ||= Math.abs(matrix.b) > 0.005 || Math.abs(matrix.c) > 0.005;
            }
          }
          const live = liveScreen(doc);
          const settled = performance.now() - started >= 1800 && stageElement.dataset.duoPhase === "idle" && doc.querySelector('[aria-label="Fold position"]')?.getAttribute("aria-busy") === "false" && !!live && lit(live);
          if (performance.now() < end && !settled) win.requestAnimationFrame(sample);
          else resolve();
        };
        win.requestAnimationFrame(sample);
      });
      check(blankStageFrames === 0, `${pose}: a physical display remains visible on every sampled frame`);
      check(blackVisibleFrames === 0, `${pose}: decoded WebRTC frames remain visible through LCD handoff (${blackVisibleFrames} black face samples: ${blackDetails.join(", ")})`);
      check(movingFrames >= 8, `${pose}: visible geometry actually animates (${movingFrames} motion frames)`);
      check(motionStartedAt - started < 2000, `${pose}: decoded destination ready before turn (${Math.round(motionStartedAt - started)}ms)`);
      if (cachedDestination) check(motionStartedAt - started < 150, `${pose}: retained destination starts the turn promptly (${Math.round(motionStartedAt - started)}ms)`);
      if (directCoverOpen) check(rightLeafDetour < 0.001, `${pose}: supporting right leaf stays flat throughout the direct cover/open turn`);
      if (innerTransition) {
        check(unreadableInnerFrames === 0, `Transition to ${pose}: native content stays upright and readable throughout (${unreadableInnerFrames}/${frames} unreadable frames; ${transitionPixel})`);
        check(splitInnerFrames === 0, `Transition to ${pose}: both leaves stay synchronized throughout (${splitInnerFrames}/${frames} split frames)`);
        check(innerAsymmetry < 0.002, `Transition to ${pose}: leaves flatten symmetrically (error ${innerAsymmetry.toFixed(4)})`);
        check(!innerReversal, `Transition to ${pose}: hinge motion is monotonic`);
        check(innerMidpointAt > 180 && innerMidpointAt < 380, `Transition to ${pose}: reaches its midpoint in ${Math.round(innerMidpointAt)}ms`);
        check(motionSettledAt > 400 && motionSettledAt < 650, `Transition to ${pose}: settles in ${Math.round(motionSettledAt)}ms`);
      }
      if (pose === "Fold") {
        check(coverTurnAt > 450 && coverTurnAt < 800, `Fold: closing passes edge-on in ${Math.round(coverTurnAt)}ms (reference ≈550ms)`);
        check(motionSettledAt > 900 && motionSettledAt < 1250, `Fold: closing settles gently in ${Math.round(motionSettledAt)}ms`);
        const fronts = [...doc.querySelectorAll<HTMLElement>("[data-fold-front]")];
        check(fronts.every(front => win.getComputedStyle(front).visibility === "hidden"), "Fold: neither inner screen nor its chrome leaks beside the cover");
        check(!doc.querySelector("[data-fold-crease]"), "Fold: no synthetic hinge line can protrude beside the cover");
        check(closingCoverFrames >= 3 && darkClosingCoverFrames > 0 && darkClosingCoverFrames < closingCoverFrames, `Fold: outer LCD crosses the dark hinge phase (${darkClosingCoverFrames}/${closingCoverFrames} frames)`);
        check(Number(win.getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-dark]")!).opacity) === 0 && win.getComputedStyle(doc.querySelector<HTMLElement>("[data-fold-cover-content]")!).filter === "none", "Fold: settled outer LCD is visible and sharp");
      }
      const stageHeight = doc.querySelector('[data-fold-stage]')!.getBoundingClientRect().height;
      check(Math.abs(stageHeight / referenceHeight - 1) < 0.02, `${pose}: rigid device height stays constant`);
      if (pose !== "Fold") check(win.getComputedStyle(doc.querySelector<HTMLElement>('[data-fold-door-back]')!).visibility === "hidden", `${pose}: cover face cannot occlude the live inner display`);
      check(leakedCoverEdges === 0, `${pose}: inner LCD never leaks through the cover hinge gutter (${leakedCoverEdges} exposed samples)`);
      check(frames >= 15, `${pose}: sampled transition (${frames} frames)`);
      check(maxHeightStep < 0.12, `${pose}: continuous cover/spread sizing (largest frame step ${(maxHeightStep * 100).toFixed(1)}%)`);
      check(!foldsAway, `${pose}: door swings toward the viewer`);
      const live = liveScreen(doc);
      check(!!live && lit(live), `${pose}: live decoded display is lit`);
      if (opening) {
        check(motionSettledAt >= 850 && motionSettledAt < 1250, `${pose}: reference opening settles in ${Math.round(motionSettledAt)}ms (expected 0.85–1.25s)`);
        check(maxCenterExcursion > 0.07 && maxCenterExcursion < 0.18, `${pose}: reference rightward translation ${(maxCenterExcursion * 100).toFixed(1)}% (reference ≈13%)`);
        const extraGradients = [...doc.querySelectorAll<HTMLElement>('[data-fold-front] div')].filter(el => win.getComputedStyle(el).backgroundImage.includes("gradient"));
        check(extraGradients.length === 0, `${pose}: native opening shadow is not doubled by browser gradients`);
        check(finalNativeShadow < 8, `${pose}: actual WebRTC opening effect clears (peak ${maxNativeShadow.toFixed(1)}, settled ${finalNativeShadow.toFixed(1)} mean marker difference)`);
        check(coverVisibleFrames >= 3 && litCoverFrames === coverVisibleFrames, `${pose}: opening starts with a lit cover and keeps it until edge-on (${litCoverFrames}/${coverVisibleFrames} frames)`);
        check(darkOpeningInnerFrames >= 2, `${pose}: inner LCD stays dark through the edge-on handoff (${darkOpeningInnerFrames} frames)`);
      }
      check(syntheticBlurFrames === 0, `${pose}: native LCD effect has no added CSS blur (${syntheticBlurFrames} filtered frames)`);
      check(!rotated, `${pose}: no whole-device rotation`);
      check(!panelLayoutChanged, `${pose}: each physical LCD keeps its own stream geometry during handoff`);
      check(!detached && !empty, `${pose}: live screen remains mounted`);
      check(button(doc, pose).getAttribute("aria-pressed") === "true" && doc.querySelector('[aria-label="Fold position"]')?.getAttribute("aria-busy") === "false", `${pose}: confirmed selected pose`);
      if (pose !== "Fold") await checkFreshHalves(doc, pose);
      else {
        const slot = doc.querySelector<HTMLElement>("[data-fold-door-back] [data-devicekit-screen]")!.getBoundingClientRect();
        const canvas = doc.querySelector<HTMLCanvasElement>('[data-fold-door-back] canvas[data-stream-codec="webrtc"]')!;
        const rendered = canvas.getBoundingClientRect();
        check(Math.abs(rendered.height / slot.height - 1) < 0.015 && Math.abs(rendered.width / slot.width - 1) < 0.015, "Fold: cover stream fills DeviceKit cutout without stretched chrome or letterboxing");
        const before = fixtureCounter(doc, "cover");
        const deadline = performance.now() + 8000;
        while ((fixtureCounter(doc, "cover") === null || fixtureCounter(doc, "cover") === before) && performance.now() < deadline) await delay(50);
        check(performance.now() < deadline, "Fold: the actual cover display advances before opening again");
        await checkInput(doc, true);
      }
      if (pose === "Half Fold") {
        check(!doc.querySelector("[data-fold-crease]"), "Half Fold: perspective supplies hinge depth without a synthetic center line");
        const leftRect = doc.querySelector('[data-fold-leaf="left"]')!.getBoundingClientRect();
        const rightRect = doc.querySelector('[data-fold-leaf="right"]')!.getBoundingClientRect();
        const widthRatio = (rightRect.right - leftRect.left) / doc.querySelector('[data-fold-stage]')!.getBoundingClientRect().width;
        check(widthRatio > 0.82 && widthRatio < 0.89, `Half Fold: book width is ${(widthRatio * 100).toFixed(1)}% of flat spread (Device Hub ≈85%)`);
        await checkInput(doc);
        for (const side of ["left", "right"]) {
          const leaf = doc.querySelector<HTMLElement>(`[data-fold-leaf="${side}"]`);
          if (!leaf) throw new Error(`Missing ${side} book leaf`);
          const outer = edgeHeight(doc, leaf, side === "left" ? "0" : "100%");
          const spine = edgeHeight(doc, leaf, side === "left" ? "100%" : "0");
          check(outer / spine > 1.02 && outer / spine < 1.10,
            `Half Fold ${side}: recessed spine, outer/spine=${(outer / spine).toFixed(3)} (Device Hub ≈1.04)`);
        }
      }
      if (pose === "Unfold") {
        check(!doc.querySelector("[data-fold-crease]"), "Unfold: no synthetic center line is rendered");
        check([...doc.querySelectorAll<HTMLElement>("[data-fold-leaf]")].every(leaf => win.getComputedStyle(leaf).transform === "none"), "Unfold: flat leaves leave 3D compositing cleanly");
        check([...doc.querySelectorAll<HTMLElement>("[data-fold-front]")].every(front => win.getComputedStyle(front).filter === "none"), "Unfold: flat leaves have no rasterized center shadow");
      }
    }
    await checkRotation(doc);
    await checkInput(doc);
    await checkSlider(doc);
    await checkFreshHalves(doc, "After slider");
    const right = doc.querySelector<HTMLCanvasElement>('[data-fold-leaf="right"] [data-fold-front] canvas');
    if (!right) throw new Error("Duo acceptance requires synchronized WebRTC projections");
    const context = right.getContext("2d")!;
    const draw = context.drawImage;
    try {
      context.drawImage = () => {};
      const frozen = await sampleHalves(doc);
      check(frozen.right <= 1 && frozen.left >= 4 && frozen.mismatches > 1, "Negative control detects a deliberately frozen right leaf");
      context.clearRect(0, 0, right.width, right.height);
      check(sampleVisibleFaces(doc).some(face => !face.lit), "Negative control detects a black visible face even when its canvas stays mounted");
    } finally { context.drawImage = draw; }
    await checkFreshHalves(doc, "After restoring frozen leaf");
    checkWebRtc(doc);
    await checkMotionPreferences(doc);
    await checkHome(doc);
    output.textContent += `\n${results.some((line) => line.startsWith("FAIL")) ? "FAILED" : "PASSED"}`;
  } catch (error) {
    output.textContent += `\nERROR ${String(error)}\nFAILED`;
  } finally {
    sliderRun.disabled = run.disabled = false;
  }
};

run.disabled = false;

const inspect = document.createElement("button");
inspect.textContent = "Inspect native opening frames";
run.after(inspect);
inspect.onclick = async () => {
  inspect.disabled = true;
  try {
    const doc = await ready();
    doc.querySelector<HTMLButtonElement>('button[aria-label="Close devices sidebar"]')?.click();
    doc.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')?.click();
    document.querySelector("#native-checkpoints")?.remove();
    const strip = document.createElement("div");
    strip.id = "native-checkpoints";
    Object.assign(strip.style, { display: "flex", flexWrap: "wrap", gap: "8px" });
    inspect.after(strip);
    button(doc, "Fold").click(); await delay(3500);
    button(doc, "Half Fold").click();
    const start = performance.now();
    for (const at of [100, 400, 800, 1000, 1200, 1400, 1600, 1800, 2200]) {
      await delay(Math.max(0, at - (performance.now() - start)));
      const source = doc.querySelector<HTMLVideoElement>('video[data-duo-webrtc-source]')!;
      const item = document.createElement("div");
      const label = document.createElement("div"); label.textContent = `${Math.round(performance.now() - start)}ms raw WebRTC ${source.videoWidth}×${source.videoHeight}`;
      const canvas = document.createElement("canvas"); canvas.width = 280; canvas.height = 200;
      const context = canvas.getContext("2d")!;
      context.translate(280, 0); context.rotate(Math.PI / 2); context.drawImage(source, 0, 0, 200, 280);
      item.append(label, canvas); strip.append(item);
    }
    strip.scrollIntoView();
  } finally { inspect.disabled = false; }
};

const sliderRun = document.createElement("button");
sliderRun.textContent = "Run slider regressions";
run.after(sliderRun);
sliderRun.onclick = async () => {
  sliderRun.disabled = run.disabled = true;
  results.length = 0;
  try {
    const doc = await ready();
    button(doc, "Fold").click(); await delay(3500);
    button(doc, "Unfold").click(); await delay(4500);
    await checkSlider(doc);
    output.textContent += `\n${results.some(line => line.startsWith("FAIL")) ? "FAILED" : "PASSED"}`;
  } finally { sliderRun.disabled = run.disabled = false; }
};

const rotationRun = document.createElement("button");
rotationRun.textContent = "Run rotation regressions";
run.after(rotationRun);
rotationRun.onclick = async () => {
  rotationRun.disabled = sliderRun.disabled = run.disabled = true;
  results.length = 0;
  output.textContent = "Running…";
  try {
    const doc = await ready();
    button(doc, "Unfold").click();
    await delay(1800);
    await checkRotation(doc);
    await checkInput(doc);
    output.textContent += `\n${results.some(line => line.startsWith("FAIL")) ? "FAILED" : "PASSED"}`;
  } catch (error) {
    output.textContent += `\nERROR ${String(error)}\nFAILED`;
  } finally {
    rotationRun.disabled = sliderRun.disabled = run.disabled = false;
  }
};

const unsupportedRun = document.createElement("button");
unsupportedRun.textContent = "Run unsupported-device regression";
run.after(unsupportedRun);
unsupportedRun.disabled = !unsupportedDevice;
unsupportedRun.onclick = async () => {
  unsupportedRun.disabled = rotationRun.disabled = sliderRun.disabled = run.disabled = true;
  results.length = 0;
  output.textContent = "Running…";
  try {
    await checkUnsupportedDevice();
    output.textContent += `\n${results.some(line => line.startsWith("FAIL")) ? "FAILED" : "PASSED"}`;
  } catch (error) {
    output.textContent += `\nERROR ${String(error)}\nFAILED`;
  } finally {
    unsupportedRun.disabled = rotationRun.disabled = sliderRun.disabled = run.disabled = false;
  }
};
