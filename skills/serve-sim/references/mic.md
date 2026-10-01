# Microphone injection reference

## Contents

- What microphone injection does
- Requirements
- Feeding audio: say and play
- Timing: --wait and --pre-roll
- Idle modes
- Status and teardown
- Typical end-to-end recipe
- Limits

## What microphone injection does

`npx @expo/serve-sim mic <bundle-id>` replaces the simulator's microphone input for one app. A host helper streams 48 kHz PCM into a POSIX shared-memory ring. An injected dylib (`DYLD_INSERT_LIBRARIES`) wraps the app's CoreAudio HAL IOProc and writes that PCM over the real input buffers.

Every recording API in the simulator ends in that IOProc, so one hook covers AVAudioEngine, AVAudioRecorder, AudioQueue, the RemoteIO and VoiceProcessingIO audio units, and `SFSpeechRecognizer` fed from an engine tap. The app needs no code changes.

The helper is one per device and outlives app launches. Run `mic <other-bundle-id>` to bring another app into the same feed.

## Requirements

- An Apple silicon Mac and an iOS Simulator runtime.
- The app is relaunched with the dylib. `mic <bundle-id>` grants microphone access first, so no permission prompt appears.
- `say` uses macOS text to speech, so it works offline.

## Feeding audio

```sh
npx @expo/serve-sim mic com.acme.MyApp                         # relaunch with the mic injected
npx @expo/serve-sim mic say "Add milk to my shopping list" -q   # text to speech
npx @expo/serve-sim mic play ~/Desktop/command.mp3 -q           # any AVAudioFile format
npx @expo/serve-sim mic voices                                  # list voices for --voice
npx @expo/serve-sim mic say "Hallo" --voice Anna --rate 160 -q
```

A new `say` or `play` replaces the clip that is playing.

## Timing

The app hears a clip about 100 ms after the command, plus any pre-roll.

- `--wait` returns only after the clip has played. Use it before you check the app's UI.
- `--pre-roll <ms>` adds silence first. Use it when the app needs time to start listening after a tap.

Start the app's recording first (tap the record button), then send the clip.

## Idle modes

Between clips the app hears:

- `silence` (default): digital silence, so tests do not depend on room noise.
- `passthrough`: the Mac's real microphone.

```sh
npx @expo/serve-sim mic idle passthrough
npx @expo/serve-sim mic com.acme.MyApp --passthrough   # set it at launch
```

## Status and teardown

```sh
npx @expo/serve-sim mic status    # JSON: alive, playing, path, durationMs, positionMs, idle, bundleIds
npx @expo/serve-sim mic stop      # cut the current clip
npx @expo/serve-sim mic off       # stop the helper and terminate the injected apps
```

## Typical end-to-end recipe

```sh
npx @expo/serve-sim mic com.acme.VoiceNotes -q
npx @expo/serve-sim tap 0.5 0.9                           # start recording in the app
npx @expo/serve-sim mic say "Remind me to call Sam" --pre-roll 300 --wait -q
npx @expo/serve-sim tap 0.5 0.9                           # stop recording
# Verify the transcript through the accessibility tree or a screenshot.
npx @expo/serve-sim mic off -q
```

## Limits

- The dylib loads at launch only, so an app that is already running must be relaunched with `mic <bundle-id>`.
- A `mic` relaunch loads only the mic dylib. An app that had the camera injected loses the camera feed.
- Clips are limited to 10 minutes.
