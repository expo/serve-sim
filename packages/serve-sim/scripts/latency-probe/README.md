# Tap-to-frame latency probe

Measures how long a tap in the preview takes to show up as a changed video
frame in the viewer's browser. It drives the real preview page with Playwright,
so the number covers the whole path: browser input event → control WebSocket →
HID injection → iOS render → SimulatorKit capture → encode → WebRTC → decode.
It stops at "decoded frame available to the page"; a real viewer adds up to one
display refresh for compositing.

## How it works

- `flip.html` is a page for the simulator's Safari. It toggles between black
  and white on every `touchstart`.
- `probe.mjs` opens the preview, attaches a `MediaStreamTrackProcessor` to the
  remote video track, taps the centre of the device N times, and records the
  time from the page's `mousedown` event to the first decoded frame whose
  centre luminance crossed 50%. It prints p50/p90/p95 and dumps receiver and
  sender WebRTC stats.

Do not sample through `<video>` + `<canvas>`: in Playwright's Chromium,
`requestVideoFrameCallback` stalls after a few frames and `drawImage(video)`
returns stale pixels for a GPU-backed WebRTC frame. Reading frames off the track
avoids both problems.

## Run

```sh
# 1. Serve the flip page and open it in a booted simulator.
python3 -m http.server 8765 --directory packages/serve-sim/scripts/latency-probe --bind 127.0.0.1 &
xcrun simctl openurl booted http://127.0.0.1:8765/flip.html

# 2. Start serve-sim with the flags under test (these are the EAS production flags).
node packages/serve-sim/dist/serve-sim.js --port 3399 --host 127.0.0.1 \
  --transport webrtc --webrtc-codec vp8 --max-dimension 960 \
  --mjpeg-quality 0.55 --video-bitrate 6000000 --video-fps 60 <udid>

# 3. Run the probe (needs `playwright` + its Chromium; `npx -y playwright@1.62 install chromium`).
cd /tmp && mkdir -p probe && cd probe && npm i playwright@1.62 && cd -
NODE_PATH=/tmp/probe/node_modules node packages/serve-sim/scripts/latency-probe/probe.mjs \
  "http://127.0.0.1:3399/?device=<udid>" \
  "http://127.0.0.1:3399/helper/<udid>/webrtc/stats" 25 ./run.json baseline
```

Run at least 25 taps per configuration and compare p50 and p95, not single
samples. Keep the simulator, Safari page and browser window identical between
runs.

## Results so far (2026-08-29, M5 Pro bare metal, loopback, iPhone 17 / iOS 26.5)

| configuration | p50 | p90 | p95 | max | encode/frame | decode/frame |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1.51 production flags (VP8 442x960, pump holds frames to the 60 Hz grid), run 1 | 37.5 ms | 42.5 | 42.9 | 46.9 | 0.59 ms | 0.32 ms |
| same, run 2 | 32.3 ms | 38.6 | 42.4 | 85.1 | — | — |
| fresh frames sent on arrival (prototype of the send-on-arrival pump), run 1 | 22.2 ms | 26.0 | 30.0 | 30.4 | 0.66 ms | 0.31 ms |
| same, run 2 | 22.8 ms | 34.7 | 38.2 | 79.9 | — | 0.33 ms |
| send on arrival, `--max-dimension 1280` (588x1280) | 26.7 ms | 32.7 | 32.7 | 44.0 | 0.87 ms | 0.60 ms |
| send on arrival, `--max-dimension 0` (1206x2622) | 27.1 ms | 42.7 | 42.7 | 58.6 | 2.26 ms | 1.94 ms |

Sending fresh frames on arrival is the default from the `webrtc-send-on-arrival`
change onward; the rows above compare it against the 0.1.51 hold-for-slot pump.
