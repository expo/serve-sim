# Video pipeline and recording

This describes the H.264 WebRTC and session-recording paths. See
[WebRTC architecture](webrtc-architecture.md) for signaling and control, and
[API](api.md) for the recording endpoint. HTTP video remains a separate transport.

## Frame flow

```text
SimulatorKit active-panel IOSurface
  -> CVPixelBuffer view of the surface
  -> one owned native-size snapshot while recording
       |-> latest-frame mailbox -> hardware H.264 recorder -> MP4 + session.json
       `-> viewer scale/letterbox -> shared H.264 encoder -> N WebRTC senders
```

`FrameCapture` follows CoreDevice's authoritative active display on a foldable
simulator. It combines SimulatorKit callbacks with a 60 Hz IOSurface seed poll;
that poll is a fallback cadence, not a ceiling on callback-driven changes. Seed
checks avoid copying unchanged pixels except for the capture idle floor. A
`CVPixelBuffer` initially wraps the IOSurface without copying it. The capture
queue then makes an owned snapshot so encoders can retain a frame after the
simulator reuses the surface.

When recording is inactive, the snapshot uses the configured capture size.
Starting recording changes it to native size and publishes the latest owned
buffer to a one-slot mailbox. WebRTC, HTTP consumers, the recording clock, and
disk work do not run on the capture queue. A slow consumer replaces or drops
pending work instead of accumulating a frame backlog. Stopping recording
restores the configured capture size.

The normal snapshot uses VideoToolbox pixel transfer into a pooled buffer. An
odd-size BGRA panel uses a Metal-backed Core Image copy into an even-size
buffer, preserving the right and bottom pixels. A failed normal transfer can
fall back to a CPU copy, and capture reports that count; the expected
recording-plus-WebRTC path uses the accelerated transfer. Neither a
`CVPixelBuffer` wrapper nor a GPU transfer guarantees that the simulator is
never delayed by a surface fence. Direct copy and viewer-scale latencies still
need separate measurements.

## WebRTC viewers

`WebRTCPublisher` paces the latest captured frame at the configured viewer
rate and scales or letterboxes it to a fixed viewer canvas. A custom H.264
encoder factory gives each peer a proxy over one `VTCompressionSession`.
Proxies deduplicate submissions by frame timestamp and distribute the one
compressed result to the peers. The shared target bitrate is the minimum of
active peers' requests; a join or PLI requests an IDR. Each peer still owns
its connection, congestion controller, and RTP packet stream.

Viewer size, rate, bitrate, and negotiated H.264 level affect the live stream,
not the recording. If the fixed H.264 canvas is not ready or an offered H.264 level cannot decode
it, a viewer offering VP8 uses the existing per-peer software path. An H.264-only
viewer retries when the canvas becomes ready or must offer a sufficient level.
The same VP8 path remains when the H.264 hardware probe fails. The recording
encoder is independent of those fallbacks.

## Session recording

`NativeVideoRecorder` owns a separate VideoToolbox H.264 compression session.
It requires and checks hardware acceleration on the actual session; failure
stops recording rather than silently choosing software encoding. Hardware
H.264 encoding is a video-encoder operation, not necessarily a GPU shader.
The encoder identity and frame counts are reported when recording finishes.

The recorder's fixed canvas takes the maximum width and height across the
simulator's native panels, rounded up to even dimensions. The active panel is
placed on that canvas during fold and unfold; the file dimensions do not
change. If the owned snapshot already matches the canvas, it goes directly to
the encoder. Otherwise VideoToolbox pixel transfer letterboxes it. The
recording path has no CPU scaling fallback.

A monotonic 60 Hz timer submits the latest safe snapshot and repeats it when
the simulator has no new image. Thus 60 output samples per second is a target,
not a promise of 60 distinct rendered frames. The recorder bounds pending
frames, pixel buffers, and writer work, and counts coalesced ticks, drops,
repeats, backpressure, and encode time. Overloaded hosts can miss the target.

Compressed H.264 samples go to `AVAssetWriterInput` with `outputSettings: nil`,
so the MP4 writer does not encode again. On successful finalization the output
directory contains `recording.mp4` and `session.json`. The manifest keeps the
record-sim upload contract: `firstFrameWallClock` with `unixMs` and `iso8601`,
`width`, `height`, and `recording`.

## Control and shutdown

Start a token-gated serve-sim session for the device, then run:

```sh
serve-sim record-video --udid <udid> --output <empty-dir>
# Send SIGINT to stop; the command exits after session.json is available.
```

The CLI owns a recording lease and renews it while running. A client with a
different recording ID cannot stop that recording. Serve-sim finalizes an
active recording on SIGTERM, SIGINT, or SIGHUP before the process exits. The
CLI also waits for the manifest when the server stops during recording.
Allow sufficient shutdown time for the VideoToolbox flush and MP4 writer.

The build-tools consumer uses this command in place of record-sim. Roll out
the serve-sim version containing `record-video` before deploying the consumer;
an older binary cannot satisfy that command. The upload schema is unchanged.

## Performance and validation

With recording and N H.264 viewers, the intended cost is one framebuffer
capture, one shared viewer encode, and one full-resolution recording encode.
The former record-sim path took a second framebuffer capture and CPU-locked
copy. It also encoded independently of the WebRTC peers. For one viewer,
encoder count remains two; for two or more viewers, sharing removes the extra
per-viewer H.264 encodes. The second recording encode preserves native size
and cadence when viewer bitrate, resolution, or transport changes.

Pinned Tart checks demonstrated two simultaneous H.264 viewers and a
full-resolution MP4. Both viewers received 830 RTP packets in a 12-second
window while the shared encoder completed 646 frames; recording used a
separate hardware-reported VideoToolbox session. An iPhone recording wrote
5,423 frames over 90.4 seconds at 59.99 fps average. A Duo fold/unfold run
kept a 2008×2854 canvas and showed both panels, but averaged about 54.7 fps
under load and included a 0.9-second black interval at the transition.
These results establish concurrent operation and file quality in the tested
VMs, not stable 60 fps across workloads. Direct copy/scale latency and a
before/after CPU baseline against record-sim remain unmeasured.
