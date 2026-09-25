## What

<!-- One behavior change. Under roughly 400 changed lines. Split anything larger into a stack. -->

## Why

## Authorship and LLM use

<!-- Cover code, tests, documentation, and this PR description. A short, accurate account is enough; a session transcript is optional. Do not claim human review or testing that has not happened. -->

- **LLM involvement:** None / assisted / primarily LLM-generated. Name the tool and the parts it produced or changed.
- **Process and decisions:** What was the initial request? What approach was chosen, what alternatives or suggestions were rejected or corrected, and who made those decisions?
- **Iterations:** Briefly trace the initial draft and each meaningful review or refinement round. For each, name who requested, made, and reviewed the change (human or LLM). Update this after further PR edits.
- **Human involvement:** Who set the direction, edited the result, inspected the diff, or ran the tests? If a step had no human involvement, say "none."
- **Review status:** Has a human reviewed the final diff? If not, say "human review pending." Who can answer questions and maintain this change?

## Evidence

<!-- Match the evidence to the change. "Builds and typechecks" is not evidence. -->

Check every line. Where a line does not apply, write `n/a` and why after it.

- [ ] `bun run check` is green.
- [ ] `bun run build` then `bun run test` is green.
- [ ] Simulator-backed tests for the touched area ran on a simulator you booted: `SERVE_SIM_TEST_UDID=<udid> bun run test:e2e -- <paths>`. Tests, UDID, device, Xcode:
- [ ] Change under `Sources/StreamingPolicy`: `swift test --filter StreamingPolicyTests` in `packages/serve-sim` is green.
- [ ] The failing test came first. Commit:
- [ ] Evidence for this change type is below. UI: screenshot or video. CLI or native: the command and its output. Docs only: say so.

```
paste the command and its output here
```

## Rollback

<!-- "Plain revert", or what a reverter must know: a state file format, a new flag, a schema. -->
