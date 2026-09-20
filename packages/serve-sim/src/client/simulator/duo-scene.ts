import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { DuoModelViewProps } from "../components/duo-model-view";
import { duoPose, duoIntendedScreen, duoScreenRoll, duoFrameMatchesDisplay, duoScreenMapping, duoScreenPoint, stepDuoSpring, type DuoScreenMapping } from "./duo-pose";
import { HID_EDGE_BOTTOM, HID_EDGE_LEFT, HID_EDGE_RIGHT, HID_EDGE_TOP, HOME_INDICATOR_BAND_NORM, rawEdgeForDisplayEdge, streamDisplayGeometry } from "./orientation";
import modelData from "../assets/iphone-duo/model.glb.gz.txt" with { type: "text" };

export type DuoSceneState = Omit<DuoModelViewProps, "children">;
type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;
type Surface = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; texture: THREE.CanvasTexture; material: THREE.MeshBasicMaterial; meshes: THREE.Mesh[]; ready: boolean; mapping?: DuoScreenMapping; mappingConfigKey?: string };

let modelBytes: Promise<ArrayBuffer> | undefined;
function loadModel() {
  modelBytes ??= (async () => {
    const bytes = Uint8Array.from(atob(modelData.trim()), (char) => char.charCodeAt(0));
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  })();
  return modelBytes.then((bytes) => new GLTFLoader().parseAsync(bytes, ""));
}

/** Owns GPU resources and the animation loop; React only supplies requested state. */
export function createDuoScene(
  host: HTMLElement,
  sourceHost: HTMLElement,
  state: () => DuoSceneState,
  callbacks: { ready: () => void; error: () => void },
) {
  let disposed = false;
  let failed = false;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    callbacks.error();
    return { dispose() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
  camera.position.set(0, 0, 31);
  const root = new THREE.Group();
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8290a2, 2));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(-6, 10, 14);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc7dcff, 2);
  fill.position.set(8, -3, 5);
  scene.add(fill);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();

  const createSurface = (width: number, height: number): Surface => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false })!;
    context.fillStyle = "#080a10";
    context.fillRect(0, 0, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.FrontSide });
    return { canvas, context, texture, material, meshes: [], ready: false };
  };
  const inner = createSurface(1600, 1125);
  const cover = createSurface(784, 1140);
  const originals = new Set<THREE.Material>();
  let left: THREE.Object3D | undefined;
  let right: THREE.Object3D | undefined;
  let model: THREE.Group | undefined;
  let fold = 0;
  let velocity = 0;
  let firstPose = true;
  let presentationRoll = 0;
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const targetQuaternion = new THREE.Quaternion();
  const center = new THREE.Vector3();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);

  let cancelInput = () => {};
  function fail() {
    if (disposed || failed) return;
    failed = true;
    cancelInput();
    renderer.setAnimationLoop(null);
    callbacks.error();
  }
  renderer.domElement.addEventListener("webglcontextlost", fail);

  function disposeModel(object: THREE.Object3D) {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) originals.add(material);
    });
    for (const material of originals) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) {
        value.dispose();
        if (value.image instanceof ImageBitmap) value.image.close();
      }
      material.dispose();
    }
  }

  void loadModel().then((gltf) => {
    if (disposed || failed) { disposeModel(gltf.scene); return; }
    model = gltf.scene;
    left = model.getObjectByName("left-half");
    right = model.getObjectByName("right-half");
    if (!left || !right) throw new Error("Missing iPhone Duo hinge groups");
    const displays: THREE.Mesh[] = [];
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.name.startsWith("inner-display") || child.name === "cover-display") displays.push(child);
    });
    // UVs span both inner halves. No duplicated stream or seam down the hinge.
    for (const surface of [inner, cover]) {
      surface.meshes = displays.filter((mesh) => (mesh.name === "cover-display") === (surface === cover));
      const bounds = new THREE.Box3();
      for (const mesh of surface.meshes) {
        mesh.geometry.computeBoundingBox();
        bounds.union(mesh.geometry.boundingBox!);
      }
      const size = bounds.getSize(new THREE.Vector3());
      for (const mesh of surface.meshes) {
        const position = mesh.geometry.getAttribute("position");
        const uv = new Float32Array(position.count * 2);
        for (let i = 0; i < position.count; i++) {
          const x = (position.getX(i) - bounds.min.x) / size.x;
          uv[i * 2] = surface === cover ? 1 - x : x;
          uv[i * 2 + 1] = (position.getY(i) - bounds.min.y) / size.y;
        }
        mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) originals.add(material);
        mesh.material = surface.material;
      }
    }
    root.add(model);
    callbacks.ready();
  }).catch(fail);

  function currentSource(): FrameSource | null {
    const video = sourceHost.querySelector("video");
    if (video && video.readyState >= 2 && video.videoWidth) return video;
    const canvas = sourceHost.querySelector("canvas");
    if (canvas && canvas.width > 1 && canvas.height > 1) return canvas;
    const images = sourceHost.querySelectorAll("img");
    for (let index = images.length - 1; index >= 0; index--) {
      const image = images[index]!;
      if (image.complete && image.naturalWidth > 1) return image;
    }
    return null;
  }
  let lastImage = "";
  let lastVideoTime = -1;
  let lastScreenKey = "";
  function updateScreen() {
    const current = state();
    const config = current.streamConfig;
    const physicalPose = current.physicalPose === undefined ? current.pose : current.physicalPose;
    // The native panel may go dark before its metadata switches. Freeze its
    // cached pixels and mapping as soon as the requested pose leaves it.
    if (config?.screenId !== duoIntendedScreen(current.angle, physicalPose, config?.screenId)) return;
    const source = currentSource();
    if (!source || !config || (config.screenId !== 1 && config.screenId !== 3)) return;
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    // Config and video travel independently. Keep the last correct frame until
    // the new display's frame arrives, instead of stretching the old one.
    if (!duoFrameMatchesDisplay(width, height, config)) return;
    // UVs remain fixed to the hardware through the entire pose animation.
    // The body carries the image, including cached frames on an inactive panel.
    const screenKey = `${config.screenId}:${config.width}:${config.height}:${config.orientation}`;
    if (screenKey === lastScreenKey) {
      if (source instanceof HTMLImageElement && source.src === lastImage) return;
      if (source instanceof HTMLVideoElement && source.currentTime === lastVideoTime) return;
    }
    lastScreenKey = screenKey;
    if (source instanceof HTMLImageElement) lastImage = source.src;
    if (source instanceof HTMLVideoElement) lastVideoTime = source.currentTime;
    const surface = config.screenId === 1 ? cover : inner;
    const { context, canvas } = surface;
    const mapping = duoScreenMapping(config, canvas.width, canvas.height);
    surface.mapping = mapping;
    context.fillStyle = "#080a10";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(mapping.rotation);
    context.drawImage(source, -mapping.drawnWidth / 2, -mapping.drawnHeight / 2, mapping.drawnWidth, mapping.drawnHeight);
    context.restore();
    surface.mappingConfigKey = inputConfigKey(config);
    surface.texture.needsUpdate = true;
    surface.ready = true;
    host.dataset.screenId = String(config.screenId);
    host.dataset.screenReady = "true";
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  type Point = { x: number; y: number };
  type ScreenHit = {
    point: Point;
    triangle: THREE.Triangle;
    plane: THREE.Plane;
    uv: [THREE.Vector2, THREE.Vector2, THREE.Vector2];
    isCover: boolean;
    mapping: DuoScreenMapping;
  };
  function castRay(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }
  function screenHit(clientX: number, clientY: number): ScreenHit | null {
    if (!model || failed || disposed || !castRay(clientX, clientY)) return null;
    // Intersect the entire device so a rear panel cannot receive taps through
    // the front chassis, and ignore inactive display surfaces.
    const hit = raycaster.intersectObject(root, true)[0];
    if (!hit?.uv || !hit.face || !(hit.object instanceof THREE.Mesh)) return null;
    const isCover = cover.meshes.includes(hit.object);
    const isInner = inner.meshes.includes(hit.object);
    const config = state().streamConfig;
    if ((!isCover && !isInner) || config?.screenId !== (isCover ? 1 : 3)) return null;
    const surface = isCover ? cover : inner;
    const mapping = surface.mapping;
    // A new native config can precede its video frame. The retained image is
    // still useful visually, but its transform must not target the new layout.
    if (!mapping || surface.mappingConfigKey !== inputConfigKey(config)) return null;
    const point = duoScreenPoint(hit.uv.x, 1 - hit.uv.y, mapping);
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
    const positions = hit.object.geometry.getAttribute("position");
    const uvs = hit.object.geometry.getAttribute("uv");
    const indices = [hit.face.a, hit.face.b, hit.face.c] as const;
    const vertices = indices.map((index) => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(hit.object.matrixWorld));
    const triangle = new THREE.Triangle(vertices[0], vertices[1], vertices[2]);
    return {
      point,
      triangle,
      plane: triangle.getPlane(new THREE.Plane()),
      uv: indices.map((index) => new THREE.Vector2().fromBufferAttribute(uvs, index)) as ScreenHit["uv"],
      isCover,
      mapping,
    };
  }

  // Extend the hit panel's plane beyond its edge. This keeps drags continuous
  // off the device and maps wheel directions through the same perspective,
  // physical rotation, and texture rotation as taps.
  function pointOnPanel(hit: ScreenHit, clientX: number, clientY: number): Point | null {
    if (!castRay(clientX, clientY)) return null;
    const intersection = raycaster.ray.intersectPlane(hit.plane, new THREE.Vector3());
    if (!intersection) return null;
    const weights = hit.triangle.getBarycoord(intersection, new THREE.Vector3());
    if (!weights) return null;
    const uv = hit.uv[0].clone().multiplyScalar(weights.x)
      .addScaledVector(hit.uv[1], weights.y).addScaledVector(hit.uv[2], weights.z);
    return duoScreenPoint(uv.x, 1 - uv.y, hit.mapping);
  }
  function boundedPoint(point: Point): Point {
    return { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
  }
  function homeEdge(point: Point): number | undefined {
    const orientation = streamDisplayGeometry(state().streamConfig).inputOrientation;
    const edge = rawEdgeForDisplayEdge(orientation, HID_EDGE_BOTTOM);
    const band = HOME_INDICATOR_BAND_NORM;
    const inside = edge === HID_EDGE_BOTTOM ? point.y >= band
      : edge === HID_EDGE_TOP ? point.y <= 1 - band
        : edge === HID_EDGE_LEFT ? point.x <= 1 - band
          : edge === HID_EDGE_RIGHT && point.x >= band;
    return inside ? edge : undefined;
  }
  type Contact = { id: number; point: Point; hit: ScreenHit; pointerType: string };
  type Fingers = { x1: number; y1: number; x2: number; y2: number };
  type Gesture = {
    contacts: Map<number, Contact>;
    screenId?: number;
    configKey: string;
    touch?: DuoSceneState["onTouch"];
    multi?: DuoSceneState["onMultiTouch"];
    mirrored: boolean;
    panOffset?: Point;
    edge?: number;
    fingers: Fingers;
  };
  let gesture: Gesture | null = null;
  function inputConfigKey(config = state().streamConfig) {
    return `${config?.screenId}:${config?.width}:${config?.height}:${config?.orientation}`;
  }
  function fingersFor(current: Gesture): Fingers {
    const [first, second] = [...current.contacts.values()];
    const one = first!.point;
    const two = current.mirrored
      ? boundedPoint(current.panOffset
        ? { x: one.x + current.panOffset.x, y: one.y + current.panOffset.y }
        : { x: 1 - one.x, y: 1 - one.y })
      : second?.point ?? one;
    return { x1: one.x, y1: one.y, x2: two.x, y2: two.y };
  }
  function endGesture() {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    // Release through the callback that began this gesture, even after React
    // disables input for a resize or unmounts the model.
    if (current.multi) current.multi({ type: "end", ...current.fingers });
    else current.touch?.({ type: "end", x: current.fingers.x1, y: current.fingers.y1, edge: current.edge });
    for (const id of current.contacts.keys()) {
      if (renderer.domElement.hasPointerCapture(id)) renderer.domElement.releasePointerCapture(id);
    }
  }
  cancelInput = endGesture;
  function validateGesture() {
    if (gesture && (gesture.configKey !== inputConfigKey() ||
      !(gesture.multi ? state().onMultiTouch : state().onTouch))) endGesture();
  }
  const down = (event: PointerEvent) => {
    validateGesture();
    if (event.button !== 0 || failed || disposed) return;
    const hit = screenHit(event.clientX, event.clientY);
    if (!hit) return;
    const point = boundedPoint(hit.point);
    const contact = { id: event.pointerId, point, hit, pointerType: event.pointerType };
    if (gesture) {
      const first = gesture.contacts.values().next().value;
      const multi = state().onMultiTouch;
      if (gesture.multi || event.pointerType !== "touch" || first?.pointerType !== "touch" || !multi) return;
      event.preventDefault();
      renderer.domElement.setPointerCapture(event.pointerId);
      gesture.touch?.({ type: "end", x: first.point.x, y: first.point.y, edge: gesture.edge });
      gesture.contacts.set(event.pointerId, contact);
      gesture.multi = multi;
      gesture.fingers = fingersFor(gesture);
      multi({ type: "begin", ...gesture.fingers });
      return;
    }
    const mirrored = event.altKey && event.pointerType === "mouse" && !!state().onMultiTouch;
    if (!mirrored && !state().onTouch) return;
    event.preventDefault();
    renderer.domElement.setPointerCapture(event.pointerId);
    gesture = {
      contacts: new Map([[event.pointerId, contact]]),
      screenId: state().streamConfig?.screenId,
      configKey: inputConfigKey(),
      touch: state().onTouch,
      multi: mirrored ? state().onMultiTouch : undefined,
      mirrored,
      panOffset: mirrored && event.shiftKey ? { x: 1 - 2 * point.x, y: 1 - 2 * point.y } : undefined,
      edge: homeEdge(point),
      fingers: { x1: point.x, y1: point.y, x2: point.x, y2: point.y },
    };
    gesture.fingers = fingersFor(gesture);
    if (gesture.multi) gesture.multi({ type: "begin", ...gesture.fingers });
    else gesture.touch?.({ type: "begin", ...point, edge: gesture.edge });
  };
  const move = (event: PointerEvent) => {
    validateGesture();
    const hit = screenHit(event.clientX, event.clientY);
    renderer.domElement.style.cursor = hit ? "pointer" : "default";
    const contact = gesture?.contacts.get(event.pointerId);
    if (!gesture || !contact) return;
    const point = hit?.point ?? pointOnPanel(contact.hit, event.clientX, event.clientY);
    if (!point) return;
    contact.point = boundedPoint(point);
    if (hit) contact.hit = hit;
    gesture.fingers = fingersFor(gesture);
    if (gesture.multi) gesture.multi({ type: "move", ...gesture.fingers });
    else gesture.touch?.({ type: "move", ...contact.point, edge: gesture.edge });
  };
  const up = (event: PointerEvent) => {
    if (!gesture?.contacts.has(event.pointerId)) return;
    if (event.type === "pointerup") move(event);
    endGesture();
  };
  const wheel = (event: WheelEvent) => {
    if (gesture) return;
    const hit = screenHit(event.clientX, event.clientY);
    const send = state().onScroll;
    if (!hit || !send) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const dxPixels = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1);
    const dyPixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    const xStep = pointOnPanel(hit, event.clientX + 1, event.clientY);
    const yStep = pointOnPanel(hit, event.clientX, event.clientY + 1);
    if (!xStep || !yStep) return;
    const dx = (xStep.x - hit.point.x) * dxPixels + (yStep.x - hit.point.x) * dyPixels;
    const dy = (xStep.y - hit.point.y) * dxPixels + (yStep.y - hit.point.y) * dyPixels;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
    event.preventDefault();
    event.stopPropagation();
    send({ ...hit.point, dx, dy });
  };
  const onVisibilityChange = () => { if (document.hidden) endGesture(); };
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("wheel", wheel, { passive: false });
  window.addEventListener("blur", endGesture);
  document.addEventListener("visibilitychange", onVisibilityChange);
  let previous = performance.now();
  renderer.setAnimationLoop((now) => {
    if (disposed || failed || document.hidden) return;
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    const current = state();
    validateGesture();
    try { updateScreen(); } catch { fail(); return; }
    const config = current.streamConfig;
    const physicalPose = current.physicalPose === undefined ? current.pose : current.physicalPose;
    const visibleScreen = duoIntendedScreen(current.angle, physicalPose, config?.screenId);
    const surface = visibleScreen === 1 ? cover : inner;
    // Native display changes can lag the slider. Retain the current view roll
    // until the intended panel has a matching frame, rather than orienting the
    // inner screen using stale cover metadata (or the other way around).
    if (config?.screenId === visibleScreen && surface.mappingConfigKey === inputConfigKey(config)) {
      presentationRoll = duoScreenRoll(config);
    }
    const target = duoPose(current.angle, physicalPose, config?.screenId, config, presentationRoll);
    targetQuaternion.setFromEuler(euler.set(...target.rotation));
    if (firstPose || reducedMotion.matches) {
      fold = target.fold;
      velocity = 0;
      root.quaternion.copy(targetQuaternion);
      firstPose = false;
    } else {
      const step = stepDuoSpring(fold, velocity, target.fold, dt);
      fold = step.value;
      velocity = step.velocity;
      root.quaternion.slerp(targetQuaternion, 1 - Math.exp(-10 * dt));
    }
    if (left && right) {
      left.rotation.y = fold;
      right.rotation.y = -fold;
      // Center the moving body rather than the hinge; constant camera framing
      // makes opening/closing and rapid preset interruptions continuous.
      center.set(0, 0, 4.05 * Math.sin(fold)).applyQuaternion(root.quaternion);
      root.position.copy(center).multiplyScalar(-1);
    }
    try {
      renderer.render(scene, camera);
    } catch { fail(); }
    host.dataset.hingeAngle = (180 - fold * 360 / Math.PI).toFixed(2);
    host.dataset.pose = current.pose ?? "custom";
  });

  return {
    dispose() {
      disposed = true;
      endGesture();
      renderer.setAnimationLoop(null);
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", fail);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", endGesture);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (model) disposeModel(model);
      for (const surface of [inner, cover]) { surface.texture.dispose(); surface.material.dispose(); }
      environment.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
