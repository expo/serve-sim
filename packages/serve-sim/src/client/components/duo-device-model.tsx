import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { HingePose } from "../../hinge-control";
import type { StreamConfig } from "../types";
import type { SimulatorViewProps } from "../simulator/SimulatorView";
import { simEndpoint } from "../utils/sim-endpoint";
import { duoFrameMatchesConfig, duoHomeIndicatorEdge, duoPoseRotation, duoStreamPoint, duoTextureRotation, stepDuoSpring, type SpringValue } from "./duo-model-motion";

export interface DuoDeviceModelProps {
  angle: number;
  pose?: HingePose | null;
  tableMode?: boolean;
  /** Explicit toolbar rotation, independent of app-reported orientation. */
  rotationOffset?: number;
  screenConfig: StreamConfig;
  /** Keep the transport mounted while display geometry and device pose change. */
  screen: ReactNode;
  onStreamTouch?: SimulatorViewProps["onStreamTouch"];
  onStreamMultiTouch?: SimulatorViewProps["onStreamMultiTouch"];
  onStreamScroll?: SimulatorViewProps["onStreamScroll"];
  onError?: () => void;
}

type DecodedSurface = HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;
type TouchPoint = { x: number; y: number };

type DisplayTexture = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  materials: THREE.MeshBasicMaterial[];
  rotation: number;
  initialized: boolean;
};

function createDisplayTexture(): DisplayTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#08090a";
  context.fillRect(0, 0, 2, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { canvas, context, texture, materials: [], rotation: 0, initialized: false };
}

function surfaceSize(source: DecodedSurface): [number, number] {
  if (source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight];
  if (source instanceof HTMLVideoElement) return source.readyState >= 2 ? [source.videoWidth, source.videoHeight] : [0, 0];
  return [source.width, source.height];
}

function disposeModel(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

/** Apple's device meshes, rigged around the real hinge with live simulator
 * pixels on the inner and cover displays. Animation state lives outside React
 * so changing streams or issuing another pose cannot restart an in-flight fold. */
export function DuoDeviceModel(props: DuoDeviceModelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const sourceHost = sourceRef.current;
    if (!host || !sourceHost) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    } catch {
      latest.current.onError?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const canvas = renderer.domElement;
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";
    canvas.setAttribute("aria-label", "Interactive 3D iPhone Duo");
    canvas.setAttribute("role", "img");
    canvas.dataset.duoModel = "loading";
    canvas.tabIndex = 0;
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100);
    camera.position.set(0, 0, 36);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 1.0;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x607088, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(-12, 18, 25);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xcbd9ff, 1.5);
    rim.position.set(12, 5, -8);
    scene.add(rim);

    const orientation = new THREE.Group();
    const centered = new THREE.Group();
    orientation.add(centered);
    scene.add(orientation);
    const initial = latest.current;
    let rememberedPose: HingePose = initial.pose ?? "book";
    let hinge: SpringValue = { value: initial.angle, velocity: 0 };
    const initialRotation = duoPoseRotation(initial.angle, rememberedPose);
    const rotation = initialRotation.map((value) => ({ value, velocity: 0 })) as [SpringValue, SpringValue, SpringValue];
    const inner = createDisplayTexture();
    const cover = createDisplayTexture();
    const screens: THREE.Mesh[] = [];
    const retiredMaterials: THREE.Material[] = [];
    const retiredTextures = new Set<THREE.Texture>();
    let model: THREE.Object3D | undefined;
    let left: THREE.Object3D | undefined;
    let right: THREE.Object3D | undefined;
    let halfWidth = 8.23;
    let disposed = false;
    let raf = 0;
    let lastAt = performance.now();
    let lastTextureAt = 0;
    let lastAttributeAt = 0;
    let lastSource: DecodedSurface | null = null;
    let previousSourceKey = "";
    let previousDisplay: boolean | undefined;
    let displayChangedAt = 0;
    const transitionProbe = document.createElement("canvas");
    transitionProbe.width = transitionProbe.height = 8;
    const probeContext = transitionProbe.getContext("2d", { willReadFrequently: true })!;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener("resize", resize);
    resize();

    const fail = () => {
      if (!disposed) latest.current.onError?.();
    };
    const contextLost = (event: Event) => { event.preventDefault(); fail(); };
    canvas.addEventListener("webglcontextlost", contextLost);
    const loader = new GLTFLoader();
    loader.load(simEndpoint("assets/iphone-duo/model.glb"), (gltf) => {
      if (disposed) { disposeModel(gltf.scene); return; }
      model = gltf.scene;
      left = model.getObjectByName("duo-left");
      right = model.getObjectByName("duo-right");
      if (!left || !right) { disposeModel(model); model = undefined; fail(); return; }
      const bounds = new THREE.Box3().setFromObject(right);
      halfWidth = Math.max(8, bounds.max.x - bounds.min.x);
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (object.name !== "duo-screen-left" && object.name !== "duo-screen-right" && object.name !== "duo-screen-cover") return;
        const display = object.name === "duo-screen-cover" ? cover : inner;
        const original = Array.isArray(object.material) ? object.material[0] : object.material;
        const map = original instanceof THREE.MeshStandardMaterial ? original.map ?? original.emissiveMap : null;
        const material = new THREE.MeshBasicMaterial({ map: display.initialized ? display.texture : map, color: display.initialized || map ? 0xffffff : 0x101214, toneMapped: false });
        material.polygonOffset = true;
        material.polygonOffsetFactor = -1;
        material.polygonOffsetUnits = -1;
        object.material = material;
        if (original) {
          retiredMaterials.push(original);
          for (const value of Object.values(original)) if (value instanceof THREE.Texture) retiredTextures.add(value);
        }
        object.userData.duoCover = display === cover;
        display.materials.push(material);
        screens.push(object);
      });
      if (screens.length !== 3) { fail(); return; }
      centered.add(model);
      canvas.dataset.duoModel = "ready";
      setLoaded(true);
    }, undefined, fail);

    const paintTexture = (now: number) => {
      // Texture uploads are capped separately from the 60/120 Hz hinge animation.
      if (now - lastTextureAt < 1000 / 30) return;
      lastTextureAt = now;
      if (!lastSource?.isConnected || surfaceSize(lastSource)[0] < 4 || lastSource.style.display === "none") {
        lastSource = Array.from(sourceHost.querySelectorAll<DecodedSurface>("video, canvas, img"))
          .find((surface) => surface.style.display !== "none" && surfaceSize(surface)[0] >= 4) ?? null;
      }
      const source = lastSource;
      if (!source || (source instanceof HTMLImageElement && source.currentSrc.startsWith("blob:") && !source.complete)) return;
      const [sourceWidth, sourceHeight] = surfaceSize(source);
      if (sourceWidth < 4 || sourceHeight < 4) return;
      const config = latest.current.screenConfig;
      // Active-display metadata can precede its first decoded image. Never
      // paint the outgoing cover pixels onto the retained inner display.
      if (!duoFrameMatchesConfig(sourceWidth, sourceHeight, config)) return;
      const isCover = config.screenId === 1 || (config.screenId == null && latest.current.angle < 1);
      const display = isCover ? cover : inner;
      if (previousDisplay !== isCover) {
        previousDisplay = isCover;
        displayChangedAt = now;
      }
      // CoreSimulator briefly publishes an empty IOSurface when switching
      // displays. Keep the previous screen through that handoff; an app that
      // intentionally stays black is shown once the short handoff expires.
      if (display.initialized && now - displayChangedAt < 2000) {
        // A stale encoder frame can also temporarily overwrite config sizes.
        // The retained panel shape protects this short handoff; bound it so a
        // bad initial frame can never pin a display to the wrong dimensions.
        if (!duoFrameMatchesConfig(sourceWidth, sourceHeight, display.canvas)) return;
        probeContext.drawImage(source, 0, 0, 8, 8);
        const pixels = probeContext.getImageData(0, 0, 8, 8).data;
        let blank = true;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i]! > 8 || pixels[i + 1]! > 8 || pixels[i + 2]! > 8) { blank = false; break; }
        }
        if (blank) return;
      }
      const rotation = duoTextureRotation(isCover, sourceWidth, sourceHeight, config.orientation);
      const sourceKey = `${source instanceof HTMLImageElement && source.currentSrc.startsWith("blob:") ? source.currentSrc : now}:${isCover}:${rotation}`;
      if (sourceKey === previousSourceKey) return;
      previousSourceKey = sourceKey;
      const rotated = rotation !== 0;
      const width = rotated ? sourceHeight : sourceWidth;
      const height = rotated ? sourceWidth : sourceHeight;
      const scale = Math.min(1, 1600 / Math.max(width, height));
      const targetWidth = Math.round(width * scale);
      const targetHeight = Math.round(height * scale);
      if (display.canvas.width !== targetWidth || display.canvas.height !== targetHeight) {
        display.canvas.width = targetWidth;
        display.canvas.height = targetHeight;
      }
      const ctx = display.context;
      ctx.save();
      ctx.translate(targetWidth / 2, targetHeight / 2);
      ctx.rotate(rotation);
      try {
        ctx.drawImage(source, -sourceWidth * scale / 2, -sourceHeight * scale / 2, sourceWidth * scale, sourceHeight * scale);
      } catch {
        ctx.restore();
        return;
      }
      ctx.restore();
      display.rotation = rotation;
      display.texture.needsUpdate = true;
      if (!display.initialized) {
        display.initialized = true;
        for (const material of display.materials) { material.map = display.texture; material.color.set(0xffffff); material.needsUpdate = true; }
      }
    };

    const tick = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      const current = latest.current;
      if (current.pose) rememberedPose = current.pose;
      const dt = Math.min((now - lastAt) / 1000, 0.1);
      lastAt = now;
      const targetAngle = Math.min(180, Math.max(0, current.angle));
      hinge = reducedMotion.matches ? { value: targetAngle, velocity: 0 } : stepDuoSpring(hinge, targetAngle, dt);
      const targetRotation = duoPoseRotation(targetAngle, rememberedPose);
      targetRotation[2] -= (current.rotationOffset ?? 0) * Math.PI / 180;
      for (let axis = 0; axis < 3; axis++) {
        const value = rotation[axis]!;
        // Choose the equivalent rotation closest to the current orientation.
        const target = value.value + THREE.MathUtils.euclideanModulo(targetRotation[axis]! - value.value + Math.PI, 2 * Math.PI) - Math.PI;
        rotation[axis] = reducedMotion.matches ? { value: target, velocity: 0 } : stepDuoSpring(value, target, dt, 9);
      }
      orientation.rotation.set(rotation[0].value, rotation[1].value, rotation[2].value, "YXZ");
      const fold = (180 - hinge.value) * Math.PI / 360;
      if (left) left.rotation.y = fold;
      if (right) right.rotation.y = -fold;
      centered.position.z = -halfWidth * 0.5 * Math.sin(fold);
      paintTexture(now);
      renderer.render(scene, camera);
      if (now - lastAttributeAt > 80) {
        lastAttributeAt = now;
        canvas.dataset.angle = String(targetAngle);
        canvas.dataset.currentAngle = hinge.value.toFixed(2);
        canvas.dataset.pose = current.pose ?? rememberedPose;
        canvas.dataset.animating = String(Math.abs(hinge.value - targetAngle) > 0.05 || rotation.some((value) => Math.abs(value.velocity) > 0.005));
      }
    };
    raf = requestAnimationFrame(tick);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const touches = new Map<number, TouchPoint>();
    let activePointer: number | null = null;
    let lastPoint: TouchPoint | null = null;
    let activeEdge: number | undefined;
    let multiTouch = false;
    let panOffset: TouchPoint | null = null;
    const pointAt = (event: { clientX: number; clientY: number }): TouchPoint | null => {
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const current = latest.current;
      const isCover = current.screenConfig.screenId === 1 || (current.screenConfig.screenId == null && current.angle < 1);
      const hit = raycaster.intersectObjects(screens.filter((mesh) => mesh.userData.duoCover === isCover), false)[0];
      if (!hit?.uv) return null;
      const display = isCover ? cover : inner;
      return duoStreamPoint(hit.uv.x, hit.uv.y, display.rotation);
    };
    const send = (type: "begin" | "move" | "end", point: TouchPoint) => {
      if (multiTouch && latest.current.onStreamMultiTouch) {
        const second = [...touches.entries()].find(([id]) => id !== activePointer)?.[1]
          ?? (panOffset ? { x: point.x + panOffset.x, y: point.y + panOffset.y } : { x: 1 - point.x, y: 1 - point.y });
        latest.current.onStreamMultiTouch({ type, x1: point.x, y1: point.y, x2: second.x, y2: second.y });
      } else {
        latest.current.onStreamTouch?.({ type, ...point, ...(activeEdge === undefined ? {} : { edge: activeEdge }) });
      }
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || touches.size >= 2) return;
      const point = pointAt(event);
      if (!point) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      if (activePointer !== null && lastPoint) {
        send("end", lastPoint);
        touches.set(event.pointerId, point);
        multiTouch = true;
        panOffset = null;
        send("begin", lastPoint);
      } else {
        touches.set(event.pointerId, point);
        activePointer = event.pointerId;
        lastPoint = point;
        activeEdge = duoHomeIndicatorEdge(point, latest.current.screenConfig);
        multiTouch = event.altKey;
        panOffset = event.altKey && event.shiftKey ? { x: 1 - 2 * point.x, y: 1 - 2 * point.y } : null;
        send("begin", point);
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) {
        canvas.style.cursor = pointAt(event) ? "pointer" : "default";
        return;
      }
      const point = pointAt(event) ?? touches.get(event.pointerId);
      if (!point) return;
      touches.set(event.pointerId, point);
      if (activePointer === event.pointerId) lastPoint = point;
      if (lastPoint) send("move", lastPoint);
    };
    const pointerUp = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      if (activePointer === event.pointerId) lastPoint = pointAt(event) ?? lastPoint;
      if (lastPoint) send("end", lastPoint);
      touches.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      const remaining = touches.entries().next().value;
      activePointer = remaining?.[0] ?? null;
      lastPoint = remaining?.[1] ?? null;
      multiTouch = false;
      panOffset = null;
      if (lastPoint) {
        activeEdge = duoHomeIndicatorEdge(lastPoint, latest.current.screenConfig);
        send("begin", lastPoint);
      }
    };
    const wheel = (event: WheelEvent) => {
      const point = pointAt(event);
      if (!point || !latest.current.onStreamScroll) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      // Use the local projected screen axes, including its perspective and
      // orientation. A long wheel delta often ends outside the device mesh.
      const derivative = (axis: "clientX" | "clientY") => {
        for (const step of [1, -1]) {
          const sample = pointAt({ clientX: event.clientX, clientY: event.clientY, [axis]: event[axis] + step });
          if (sample) return { x: (sample.x - point.x) / step, y: (sample.y - point.y) / step };
        }
        return { x: 0, y: 0 };
      };
      const horizontal = derivative("clientX");
      const vertical = derivative("clientY");
      const dx = (horizontal.x * event.deltaX + vertical.x * event.deltaY) * scale;
      const dy = (horizontal.y * event.deltaX + vertical.y * event.deltaY) * scale;
      latest.current.onStreamScroll({ ...point, dx, dy });
    };
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      if (activePointer !== null && lastPoint) send("end", lastPoint);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
      if (model) disposeModel(model);
      retiredMaterials.forEach((material) => material.dispose());
      retiredTextures.forEach((texture) => texture.dispose());
      inner.texture.dispose();
      cover.texture.dispose();
      environment.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, []);

  return (
    <div data-duo-stage style={{ width: "100%", height: "100%", position: "relative" }}>
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
      {!loaded && <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>Loading iPhone Duo…</div>}
      <div ref={sourceRef} aria-hidden="true" inert style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", visibility: "hidden", pointerEvents: "none", overflow: "hidden" }}>
        {props.screen}
      </div>
    </div>
  );
}
