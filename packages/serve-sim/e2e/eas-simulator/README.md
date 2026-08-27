# EAS Simulator release gate

The npm release workflow publishes the candidate as `@expo/serve-sim@next`,
then passes that exact prerelease version to `run-system-tests.sh`. The script
creates two named iOS sessions in the `expo-services/serve-sim-system-tests`
EAS project:

1. An agent-device session that opens Settings, reads the accessibility tree,
   injects a tap, and captures a screenshot.
2. An Argent session that opens Settings, reads the accessibility tree,
   injects a tap, and captures a screenshot.

Both sessions must also expose a web preview whose HTML comes from serve-sim.
Every exit path stops the active session and clears `.env.eas-simulator`.

When both gates pass, the workflow rebuilds the same commit with its stable
version and publishes it as `@expo/serve-sim@latest`. A failed gate leaves
`next` available for diagnosis and never publishes `latest`.

The nested `app.json` configures a dedicated project owned by `expo-services`.
The script creates or links it non-interactively on its first run. It does not
need `eas.json`: this directory starts hosted simulator sessions but does not
define any EAS Build profiles.

## One-time setup

- Ensure `EXPO_DEV_EXPO_GITHUB_ROBOT_ACCESS_TOKEN` can create or access the
  `serve-sim-system-tests` project under `expo-services`.
- Configure npm trusted publishing for `@expo/serve-sim` with GitHub owner
  `expo`, repository `serve-sim`, and workflow filename `release.yml`. Allow
  `npm publish`.

Running the system test manually consumes paid EAS Simulator time:

```sh
EXPO_TOKEN=... ./run-system-tests.sh <published-next-version>
```
