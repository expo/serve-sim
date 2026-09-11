// Tap-to-frame probe, v3: read decoded frames straight off the remote track
// with MediaStreamTrackProcessor (no <video>/<canvas> readback involved).
//
// Latency = page mousedown -> the first decoded frame whose centre Y-plane mean
// crossed 50%. This is everything up to "frame available to the page"; the
// compositor adds up to one display refresh on top for a real viewer.
//
// usage: node probe3.mjs <previewUrl> <statsUrl> [taps] [outJson] [label]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [previewUrl, statsUrl, tapsArg, outArg, label] = process.argv.slice(2);
const taps = Number(tapsArg ?? 20);
const outPath = outArg ?? "";

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return Number(sorted[idx].toFixed(1));
}

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
page.on("pageerror", (err) => console.error("[pageerror]", err.message));
await page.addInitScript(() => {
  window.__pcs = [];
  const proto = window.RTCPeerConnection.prototype;
  const original = proto.setRemoteDescription;
  proto.setRemoteDescription = function (...args) {
    if (!window.__pcs.includes(this)) window.__pcs.push(this);
    return original.apply(this, args);
  };
});
await page.goto(previewUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const v = document.querySelector("video");
  return !!v && v.srcObject && v.srcObject.getVideoTracks().length > 0 && v.videoWidth > 0;
}, null, { timeout: 40_000 });
console.log("video track ready");

await page.evaluate(() => {
  const v = document.querySelector("video");
  const track = v.srcObject.getVideoTracks()[0];
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  window.__probe = { frames: 0, lum: -1, transitions: [], mousedownAt: 0, error: null, format: null, lastFrameAt: 0 };
  document.addEventListener("mousedown", () => { window.__probe.mousedownAt = performance.now(); }, true);
  let buf = new Uint8Array(4 * 1024 * 1024);
  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      const now = performance.now();
      try {
        window.__probe.format = frame.format;
        const w = frame.visibleRect?.width ?? frame.codedWidth;
        const h = frame.visibleRect?.height ?? frame.codedHeight;
        const rect = { x: even(w * 0.3), y: even(h * 0.42), width: even(w * 0.4), height: even(h * 0.12) };
        const size = frame.allocationSize({ rect });
        if (buf.length < size) buf = new Uint8Array(size);
        const layout = await frame.copyTo(buf, { rect });
        const y = layout[0];
        let sum = 0;
        for (let row = 0; row < rect.height; row++) {
          const base = y.offset + row * y.stride;
          for (let col = 0; col < rect.width; col += 4) sum += buf[base + col];
        }
        const count = rect.height * Math.ceil(rect.width / 4);
        const lum = sum / count;
        const prev = window.__probe.lum;
        window.__probe.lum = lum;
        window.__probe.frames++;
        window.__probe.lastFrameAt = now;
        if (prev >= 0 && (prev < 128) !== (lum < 128)) {
          window.__probe.transitions.push({ at: now, lum, mousedownAt: window.__probe.mousedownAt, frameTimestampUs: frame.timestamp });
        }
      } catch (err) {
        window.__probe.error = String(err);
      } finally {
        frame.close();
      }
    }
  })();
});
await page.waitForTimeout(2000);
const state0 = await page.evaluate(() => ({ frames: window.__probe.frames, lum: window.__probe.lum, format: window.__probe.format, error: window.__probe.error }));
console.log("probe state after 2s:", JSON.stringify(state0));

const box = await page.evaluate(() => {
  const r = document.querySelector("video").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
const cx = box.x + box.w * 0.5;
const cy = box.y + box.h * 0.48;

const samples = [];
let misses = 0;
for (let i = 0; i < taps; i++) {
  const before = await page.evaluate(() => window.__probe.transitions.length);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  let hit = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    hit = await page.evaluate((n) => (window.__probe.transitions.length > n ? window.__probe.transitions[n] : null), before);
    if (hit) break;
    await page.waitForTimeout(3);
  }
  if (!hit) {
    misses++;
    const dbg = await page.evaluate(() => ({ frames: window.__probe.frames, lum: window.__probe.lum, error: window.__probe.error }));
    console.log(`tap ${i + 1}: no change ${JSON.stringify(dbg)}`);
  } else {
    const latency = hit.at - hit.mousedownAt;
    samples.push(latency);
    console.log(`tap ${i + 1}: ${latency.toFixed(1)} ms mousedown -> changed frame decoded`);
  }
  await page.waitForTimeout(600);
}

const receiverStats = await page.evaluate(async () => {
  const pc = window.__pcs[window.__pcs.length - 1];
  if (!pc) return null;
  const report = await pc.getStats();
  const out = {};
  report.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video") {
      out.inbound = {
        framesDecoded: s.framesDecoded, framesDropped: s.framesDropped, freezeCount: s.freezeCount,
        totalFreezesDuration: s.totalFreezesDuration, framesPerSecond: s.framesPerSecond,
        frameWidth: s.frameWidth, frameHeight: s.frameHeight, jitter: s.jitter,
        jitterBufferDelay: s.jitterBufferDelay, jitterBufferEmittedCount: s.jitterBufferEmittedCount,
        jitterBufferTargetDelay: s.jitterBufferTargetDelay, jitterBufferMinimumDelay: s.jitterBufferMinimumDelay,
        totalDecodeTime: s.totalDecodeTime, totalProcessingDelay: s.totalProcessingDelay,
        totalAssemblyTime: s.totalAssemblyTime, framesAssembledFromMultiplePackets: s.framesAssembledFromMultiplePackets,
        totalInterFrameDelay: s.totalInterFrameDelay, packetsLost: s.packetsLost, packetsReceived: s.packetsReceived,
        bytesReceived: s.bytesReceived, nackCount: s.nackCount, pliCount: s.pliCount, keyFramesDecoded: s.keyFramesDecoded,
        decoderImplementation: s.decoderImplementation,
      };
    }
    if (s.type === "candidate-pair" && s.nominated) out.pairRtt = s.currentRoundTripTime;
  });
  return out;
});
const inbound = receiverStats?.inbound;
const derived = inbound ? {
  avgDecodeMs: (inbound.totalDecodeTime / inbound.framesDecoded) * 1000,
  avgProcessingDelayMs: (inbound.totalProcessingDelay / inbound.framesDecoded) * 1000,
  avgJitterBufferMs: (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000,
  avgInterFrameMs: (inbound.totalInterFrameDelay / inbound.framesDecoded) * 1000,
  bytesPerFrame: inbound.bytesReceived / inbound.framesDecoded,
} : null;
let senderStats = null;
try { senderStats = await (await fetch(statsUrl)).json(); } catch {}

const summary = {
  label: label ?? "", previewUrl, taps, detected: samples.length, misses,
  latencyMs: { min: percentile(samples, 0), p50: percentile(samples, 50), p90: percentile(samples, 90), p95: percentile(samples, 95), max: percentile(samples, 100) },
  derived,
  encodeMsPerFrame: senderStats?.sessions?.[0]?.encodeMsPerFrame ?? null,
  senderResolution: senderStats?.sessions?.[0] ? `${senderStats.sessions[0].width}x${senderStats.sessions[0].height}` : null,
  capture: senderStats?.capture ?? null,
  receiver: receiverStats, sender: senderStats,
};
console.log(JSON.stringify({ ...summary, receiver: undefined, sender: undefined }, null, 2));
if (outPath) writeFileSync(outPath, JSON.stringify({ ...summary, samples }, null, 2));
await browser.close();
