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

## 4. Startup default / explicit-off reboot — readiness fix implemented

The full-suite failure was a failed launchctl read of
`SERVE_SIM_CAPABILITIES_CONFIG` after a capture reboot. With the experimental
launchctl isolation, setup instead returned attachment `failed`, so that
experiment is insufficient here too.

Implemented diagnostic improvement: retain `CaptureMeta.attachError` when a
reboot returns `failed`. Previously the test threw away the reason and reported
only an attachment-string mismatch.

A focused rerun with attachment diagnostics exposed another failure: the proxy
created its certificate, but the reporting addon never confirmed readiness.
Inspection found that `/ready` was sent only once, with a two-second timeout,
and failures were silently discarded. The host then waited for 30 seconds with
no possibility of recovery.

Implemented bounded retries for this idempotent announcement: at most five
attempts, separated by 250 ms, each retaining the existing two-second request
timeout. Shutdown interrupts the retry wait. Captured flow records remain
single-send. A real local control-server regression test fails before this
change and passes after it; additional tests verify the attempt budget and that
flow records are not duplicated. The timeout message now distinguishes missing
readiness confirmation from an unproven claim that the addon never loaded.

This repairs a demonstrated readiness failure mode. It does not establish that
every observed launchctl timeout has the same cause. Further recovery work
shares the bounded readiness/read-back work above. Preserve
explicit off through failure and reconnect, keep reboots serialized, and return
the failed stage in the capture status. Verify repeated on/off cycles, cleanup,
and the startup-default rule on both Xcodes before shipping recovery changes.

## Scope and evidence

The only production behavior change is bounded addon-readiness retries and a
more accurate timeout message. Launchctl isolation and app-launch retries have
not been adopted. The process fixture and E2E diagnostics are also local changes. Logs and temporary
experiments are under `/private/tmp/serve-sim-xcode27-validation` (`vm27/` for
VM results). No PR was updated, pushed, or run remotely.


## Validation of the implemented changes

- Native package and test fixtures build successfully.
- Injection E2E: 9/9 on Xcode 26.4 and 9/9 on Xcode 27 beta 6.
- Capture-launch diagnostic change: 3/3 on Xcode 26.4.
- Capture subsystem suite: 188 passing tests, including the readiness regression.
- Full real network fixture with readiness retries: 6/6 on Xcode 26.4.
- Xcode 27 focused startup-default/reboot check with readiness retries: 1/1,
  314.34 seconds including setup and teardown. This is one successful rerun,
  not evidence that all Xcode 27 startup races are eliminated.
- Typecheck, lint, and whitespace checks pass.
- No full-suite rerun is claimed after these focused changes. The earlier full
  results remain 1267/0 failures on 26 and 1263/4 failures on 27.
