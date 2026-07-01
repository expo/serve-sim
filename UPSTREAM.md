# Expo integration branch

This repository is consumed by `expo-device-hub` as a git submodule.

Expo-specific changes live on the `expo` branch. The parent `expo-device-hub`
repository pins an exact commit through its submodule gitlink, so there is no
separate `.upstream-commit` marker.

## Updating from upstream

Keep `main` as the upstream/default project history and rebase the Expo branch
on top when upstream changes:

```sh
git fetch origin
git switch expo
git rebase origin/main
```

After resolving conflicts, run the repo checks, then update the branch:

```sh
git push --force-with-lease origin expo
```

Finally, update the submodule gitlink in `expo-device-hub`:

```sh
git -C packages/serve-sim fetch origin expo
git -C packages/serve-sim checkout expo
git add packages/serve-sim
```
