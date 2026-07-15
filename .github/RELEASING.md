# Releasing `@expo/serve-sim`

Releases are created only by manually running `release.yml` against `main`.
The workflow rejects forks, non-`main` refs, initial or re-run actors without
the `maintain` or `admin` role, and confirmations that do not exactly match
`@expo/serve-sim`.

## One-time repository setup

Create a GitHub environment named `npm-release` with all of these protections:

- Restrict deployment branches to `main`.
- Require approval from the serve-sim maintainer team.
- Enable **Prevent self-review**.

The workflow pushes its tested version commit before it publishes. Repository
rules must therefore permit the workflow's `GITHUB_TOKEN` to update `main`. If
that push is rejected, the workflow stops before npm is changed.

## One-time npm setup

After `@expo/serve-sim` exists on npm, configure its trusted publisher with:

- Provider: GitHub Actions
- Organization: `expo`
- Repository: `serve-sim`
- Workflow filename: `release.yml`
- Environment: `npm-release`
- Allowed action: `npm publish`

Then set the package's publishing access to **Require two-factor authentication
and disallow tokens**. The workflow uses GitHub OIDC, so it does not need an npm
token and npm automatically attaches provenance to public releases.

The first publication of a brand-new scoped package must be bootstrapped by an
`@expo` npm owner before trusted publishing can be configured. Do not add a
long-lived npm token to this workflow.

## Running a release

In GitHub Actions, select **Release @expo/serve-sim**, choose `patch`, `minor`,
or `major`, enter `@expo/serve-sim` as the confirmation, and select `main` as
the ref. If a run fails after pushing its version commit, use GitHub's
**Re-run failed jobs** action; the run ID trailer lets the workflow resume the
same version without publishing a second bump.
