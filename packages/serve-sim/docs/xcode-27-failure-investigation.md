# Xcode 27 capture failure investigation

Tested locally against capture PR #157 (`99ad9c4`) plus the selected-Xcode
compatibility patch. Runtime: Xcode 27 beta 6, iOS 27, Tart (4 CPUs, 12 GB).
These are four failed assertions, with two sharing one startup scenario.

## 1. Non-UIKit process injection — implemented

The test used the host's `/usr/bin/true`. In this VM simctl selected x86_64;
dyld aborted because the inserted capability loader is arm64. A simulator-built
arm64 executable exited normally with the same injection armed.

Build `serve-sim-process-probe` with the existing native fixtures and invoke it
with `simctl spawn --arch=arm64`. Require the fixture in E2E preconditions and
include subprocess stderr in a failed assertion. This retains the non-UIKit
safety check without depending on the host executable's available slices.

Validation: the complete injection E2E file passes 9/9 on both Xcode 26.4 and
27 beta 6 with this change.

## 2–3. Capture at launch and missing startup JSON — unresolved runtime issue

Both assertions fail when the CLI does not finish its startup sequence. Tracing
recorded launchctl management commands reaching the existing 15-second timeout
(SIGTERM / exit 143). A diagnostic experiment cleared injection variables only
for launchctl subprocesses. Commands initially completed, but the app launch
then failed with FBSOpenApplicationServiceErrorDomain code 4. The experiment did
not make the scenario pass and is not a production change.

Implemented diagnostic improvement: detect an early child exit while waiting
for the first request or state file, and include stderr/exit status. The quiet
JSON assertion also includes startup diagnostics rather than only “Received: 0”.
The two assertions remain intact; reporting the underlying failure is not a
runtime fix.

Proposed recovery work:

1. Record structured startup stages and subprocess duration, timeout, signal,
   and exit code so boot readiness, capability arming, proxy readiness, and app
   launch are distinguishable. Avoid logging credentials or capture bodies.
2. Add a bounded post-boot control-plane readiness check before arming. Retry
   only proven transient read failures within one deadline; do not treat a
   failed read as an empty launchd environment.
3. For timed-out environment writes, read back the value before retrying or
   rolling back: the write may already have succeeded.
4. Investigate the application-service rejection independently. Retry an app
   launch only after confirming it did not start; preserve the one-launch,
   arguments, deep-link, and pre-main-capture assertions.

Do not merely increase the 90-second test wait or blindly retry launches.

## 4. Startup default / explicit-off reboot — unresolved runtime issue

The full-suite failure was a failed launchctl read of
`SERVE_SIM_CAPABILITIES_CONFIG` after a capture reboot. With the experimental
launchctl isolation, setup instead returned attachment `failed`, so that
experiment is insufficient here too.

Implemented diagnostic improvement: retain `CaptureMeta.attachError` when a
reboot returns `failed`. Previously the test threw away the reason and reported
only an attachment-string mismatch.

Proposed recovery shares the bounded readiness/read-back work above. Preserve
explicit off through failure and reconnect, keep reboots serialized, and return
the failed stage in the capture status. Verify repeated on/off cycles, cleanup,
and the startup-default rule on both Xcodes before shipping recovery changes.

## Scope and evidence

The production capture/launch behavior has not been changed by this investigation.
The process fixture and E2E diagnostics are local changes. Logs and temporary
experiments are under `/private/tmp/serve-sim-xcode27-validation` (`vm27/` for
VM results). No PR was updated, pushed, or run remotely.
