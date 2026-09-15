# Xcode 27 capture failure investigation

Local investigation against capture PR #157 (`99ad9c4`) plus selected-Xcode
compatibility changes. The second runtime is Xcode 27 beta 6 with iOS 27 in
Tart. Initial tests used 4 CPUs and 12 GB; later experiments used 8 CPUs.
Both final full suites pass; the production app-registration polling experiment
was removed in favor of a fixture installation barrier. A subsequent
app-observed input comparison identified and fixed Xcode 27's HID transport
handoff.

The original four failed assertions span three distinct issues: a test process
with the wrong architecture, capture startup failures (also causing missing
startup JSON), and capture readiness after a reboot. Evidence now separates
production reliability defects, a test-fixture registration race, and slow VM
management commands. These do not have one established root cause.

## 1. Non-UIKit process injection: test fixture corrected

The test used the host's `/usr/bin/true`. In this VM simctl selected x86_64;
dyld aborted because the inserted capability loader is arm64. A simulator-built
arm64 executable exited normally with the same injection armed.

The test now uses `serve-sim-process-probe`, built with the native fixtures and
invoked with `simctl spawn --arch=arm64`. E2E preconditions require it, and a
failed assertion includes subprocess stderr. This preserves the non-UIKit
safety check without relying on a host executable's architecture slices.

The complete injection E2E file passes 9/9 on both Xcode 26.4 and 27 beta 6.

## 2–3. Capture at launch and missing startup JSON

Both assertions fail if the CLI does not finish startup. Stage tracing exposed
two separate failures: slow simulator environment operations and an immediate
application-service rejection. E2E diagnostics now report early child exit,
stderr, and exit status while waiting for the first request or state file. The
quiet JSON assertion retains those diagnostics. The original assertions remain.

### Redundant environment publication: fixed

Each capability publication previously performed three sequential environment
reads and two unconditional writes. Launching an app after enabling capture
published the same environment again. A traced redundant write reached the
existing 15-second timeout and triggered additional rollback operations.

Publication now reuses its transaction snapshot: two live reads, followed only
by writes whose values changed. It still reads the actual simulator environment
on every transaction, so a reboot that clears the variables causes rearming.
Locking and rollback remain in place, including recovery when a failed write
has already taken effect. This reduces unnecessary simulator operations; it
does not explain why the simulator sometimes takes so long to answer one.

### Cleanup ordering and retry ownership: fixed

Final graceful session release now uses asynchronous loader removal. Both
removal paths remove our `DYLD_INSERT_LIBRARIES` entries before clearing the
config variable. Previously cleanup spent its first management call clearing
the config while leaving injection armed. Failed synchronous cleanup now keeps
the device in `armedHere`, allowing the exit handler to retry.

These changes improve interruption handling and keep the event loop responsive
during final graceful removal. Follow mode now shares preview mode's bounded
20-second shutdown budget, so a slow simulator management call cannot keep the
CLI alive past the launch E2E's 30-second deadline. No test deadline was
increased.

### App registration across reboot: reproduced outside serve-sim

A plain simctl experiment reproduced the launch rejection with injection
cleared: uninstall, install, shutdown, bootstatus, then launch. All three runs
failed with `FBSOpenApplicationServiceErrorDomain` code 4 and appinfo reporting
`NoAppRecord`. No serve-sim startup or capture was involved.

Adding an appinfo check before shutdown proved the app was registered before
reboot but could disappear afterward: two runs failed and one passed. Using a
new unique bundle identifier on each run survived reboot and launched in all
three trials, without a warm-up launch.

A UUID fixture candidate still failed in the exact cold capture E2E and was
reverted. A subsequent plain simctl experiment established delayed registration:
installation and appinfo succeeded before shutdown, then appinfo repeatedly
reported a missing record after bootstatus completed while the app bundle still
existed. Registration became available 34.58 seconds after boot, without
reinstallation or an app launch, and the subsequent launch succeeded.

A later traced Xcode 26 failure clarified why an appinfo exit code is insufficient:
immediately before the failing launch it returned success with only
`CFBundleIdentifier`, without an executable or bundle path. A production polling
experiment did not reliably fix the failure and was removed.

### Installation persistence: fixture fixed

The simulator system log recorded installation finishing, then shutdown
interrupting an `installd` request to save a LaunchServices operation through
`com.apple.lsd.modifydb`. The operation UUID could not be tied unambiguously to
the fixture in the partially decoded log, but the timing matches the immediate
install/shutdown sequence. The pending-operation directory remained populated
after simctl install returned.

An empty `Library/MobileInstallation/LaunchServicesOperations` directory proved
insufficient on Xcode 27. The cold E2E now waits for public `simctl appinfo` to
return both the executable and bundle path, gives the idle install a three-second
quiescent window, and verifies the same complete record immediately before
shutdown. It adds no warm-up launch, launch retry, or production wait. The HAR
assertion also waits for the specific request to be flushed instead of racing
the writer immediately after the origin receives it.

Three consecutive real cold-capture repetitions pass on Xcode 27 with this
barrier, followed by the passing full suite. Xcode 26 passes the same test in its
full suite. The production polling experiment remains removed.

### Shutdown signal registration race: fixed

The full Xcode 26 run exposed a separate CLI exit hang. The global signal handler
awaited asynchronous cleanup, during which a follow-mode handler could register.
Checking the listener count afterward incorrectly assumed that new handler had
received the original signal, so neither handler exited. The global handler now
captures whether another listener exists before awaiting cleanup. The actual
launch CLI regression passed 4/4 afterward and also passed in the next full run.

### VM service latency remains a separate observation

A trace showed the first launchctl read timing out before injection was armed,
even after bootstatus succeeded. Direct `simctl getenv` was also slow. Warm
launchctl runs with default architecture and explicit arm64 both completed
quickly; architecture selection does not explain all management delays.

An 8-CPU experiment booted in about 9 seconds versus about 37 seconds with
4 CPUs; initial reads took about 1–2 seconds versus 4–9 seconds. This comparison
suggests resource sensitivity but does not establish CPU allocation as the
sole cause. The reused-fixture registration failure also occurred with 8 CPUs.

## 4. Capture readiness after reboot: bounded recovery implemented

One failure was a launchctl read after reboot. A focused rerun exposed a
different failure: the proxy created its certificate, but the reporting addon
never confirmed readiness. `/ready` was sent once with a two-second timeout;
a lost announcement left the host waiting without recovery.

The idempotent announcement now retries at most five times, with 250 ms between
attempts and the existing two-second request timeout. Shutdown interrupts the
retry wait. Flow records remain single-send. A local control-server regression
reproduces the lost-announcement failure and verifies recovery, the retry budget,
and that flow records are not duplicated. The timeout message distinguishes
missing confirmation from an unsupported claim that the addon never loaded.

Reboot diagnostics also retain `CaptureMeta.attachError` instead of reporting
only an attachment mismatch. One focused Xcode 27 startup-default/reboot rerun
passed in 314.34 seconds including setup and teardown. Neither that result nor
the retry regression establishes that every failure in this scenario is fixed.

### Readiness regression fixture: reverse-DNS delay removed

The full VM suite exposed three timeouts in the new Python regression probe.
Stage tracing measured 35.03 seconds inside HTTPServer construction; a direct
`socket.getfqdn("127.0.0.1")` reproduced the same 35.04-second delay under the
VM's Homebrew Python. The system Python completed the same probe promptly.
This happened before addon initialization.

The loopback-only fixture binds its HTTPServer through TCPServer and assigns its
known display name directly, avoiding the unrelated reverse-DNS lookup. Bun's
Node-compatible `spawnSync` still hung around the threaded Python loopback server
inside Tart, while direct Python and `Bun.spawnSync` completed in under a second.
The regression now uses Bun's native subprocess API. All three tests pass within
their original deadlines; no production DNS or process behavior changed.

## Xcode 27 input transport: fixed

The original suite only asserted native send logs. A separate scene-based app
showed the gap: legacy Indigo reported successful keyboard sends under Xcode 27
beta 6, but its focused UITextField never changed. Some standalone tap attempts
were inconsistent as well.

Checks ruled out several simple explanations: fresh helpers and both startup
orders, ordinary UIWindow instead of its diagnostic subclass, active/key-window
state, successful first-responder selection, a responsive main queue, correct
402×874 window/root bounds, and correct button/text-field hit-test results.
A separate sender reported successful completions but the focused app observed
no text. Hardware-keyboard on/off did not resolve it.

The same probe in a Tart guest with Xcode 26.4 delivered its tap and every typed
character (`a` through `f`). This ruled out the VM and fixture. Current idb's
transport selection documents the matching cause: CoreSimulator 1155.4+ hands
input to the CoreDevice `dtuhidd` service. The legacy client can deliver the
right bytes and still have the guest drop them.

A minimal Xcode 27 probe looked up
`com.apple.coredevice.feature.remote.hid.digitizer`, enabled the simulator-to-host
XPC connection, sent an `IndigoKeyboardButtonEvent`, and received the service's
barrier reply. The app recorded `a`. Serve-sim now selects this transport when
the service is available and retains Indigo when it is not. Keyboard, touch,
multi-touch, scroll touch events, and arbitrary HID buttons use the selected
transport. The typing E2E now asserts the fixture's final UITextField value, so
a successful native send that is dropped before UIKit fails the suite.

The physical Mac reports CoreGraphics/Indigo keyboard type 198, versus 0 in
Tart. Earlier message-field overrides did not restore text and are not included;
the proved fix changes transport rather than opaque Indigo bytes.

## Validation status

- Native package and fixtures build successfully; lint and type checks pass.
- Injection E2E: 9/9 on each Xcode.
- Capture subsystem: 188 tests passed earlier, including readiness regressions.
- Actual network fixture: all six scenarios passed on Xcode 27 in the completed
  full run, including first requests, large POST/HAR, capture off/reconnect,
  startup defaults, and reboot. The final full Xcode 26 run passes as well.
- Three repeated cold capture runs pass on Xcode 27 with the fixture barrier and
  no production registration polling: 3/3 tests per run. The same case passes
  on Xcode 26 as part of its full suite.
- Scene-based interaction smoke passes on Xcode 26: changing stream frames,
  accessibility, taps, typing, single launch/arguments, deep link, and Home.
- The identical Tart input probe passes through legacy Indigo on Xcode 26.4.
  Xcode 27's runtime-selected DTUHID path passes app-observed tap and exact text
  checks; its real network fixture also receives both button taps.
- The final post-DTUHID matrix passes 1,278 tests with zero failures across 161
  files on each Xcode: 399.33 seconds on Xcode 26.4 and 590.01 seconds on Xcode
  27 beta 6. This includes the app-observed input assertion, cold first-request
  capture, large POST/HAR capture, reconnects, and launch cleanup.

Logs and temporary experiments are under
`/private/tmp/serve-sim-xcode27-validation`, with VM results in `vm27/`.
Changes remain local; no PR was updated or pushed, and no remote run is claimed.
