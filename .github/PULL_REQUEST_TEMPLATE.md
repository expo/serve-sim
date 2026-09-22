## What

<!-- One behavior change. Under roughly 400 changed lines. Split anything larger into a stack. -->

## Why

## Evidence

<!-- Match the evidence to the change. "Builds and typechecks" is not evidence. -->

Check every line. Where a line does not apply, write `n/a` and why after it.

- [ ] `bun run check` is green.
- [ ] `bun run build` then `bun run test` is green with no simulator booted.
- [ ] Simulator-backed tests for the touched area ran on a booted simulator. Tests, device, Xcode:
- [ ] The failing test came first. Commit:
- [ ] Evidence for this change type is below. UI: screenshot or video. CLI or native: the command and its output. Docs only: say so.

```
paste the command and its output here
```

## Rollback

<!-- "Plain revert", or what a reverter must know: a state file format, a new flag, a schema. -->
