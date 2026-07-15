# Releasing `@expo/serve-sim`

The GitHub release workflow asks EAS Workflows to build the exact commit being
released on a macOS worker. EAS returns an npm tarball, which GitHub verifies and
publishes using npm trusted publishing with GitHub OIDC.

The release does not change repository contents, create a tag, or create a
GitHub release.

## One-time setup

The GitHub repository needs an Actions secret named
`EXPO_DEV_EXPO_GITHUB_ROBOT_ACCESS_TOKEN`. It is used only to start the EAS
workflow and retrieve its artifact; it is not an npm credential.

The first publication of a new scoped package must be performed by an `@expo`
npm owner. After the package exists, configure its trusted publisher with:

- Provider: GitHub Actions
- Organization: `expo`
- Repository: `serve-sim`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

Do not configure a GitHub environment or add an npm token. npm authorizes the
publish using a short-lived OIDC credential issued to the GitHub workflow.

## Running a release

1. Bump `packages/serve-sim/package.json` in a pull request:

   ```sh
   npm version patch --no-git-tag-version --no-package-lock --workspace packages/serve-sim
   ```

   Use `minor`, `major`, or an explicit version instead of `patch` when needed.

2. Merge the version bump after CI passes.
3. In GitHub Actions, run **Release @expo/serve-sim** against `main`.

The workflow rejects versions that already exist on npm. It asks EAS to build
the selected commit, then verifies the EAS commit SHA and the tarball's package
name, version, CPU constraint, and required native files before publishing.
