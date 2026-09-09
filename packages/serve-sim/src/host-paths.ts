import { lstatSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
import { z } from "zod";

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** $TMPDIR sits behind a symlink (/var -> /private/var); a canonical path needs a root in that shape. */
const TMP_ROOT = realpathOrSelf(tmpdir());

export const UPLOAD_DIR = join(TMP_ROOT, "serve-sim-uploads");
/** Staged here; only a child writes to the Desktop (see TCC_PROTECTED_DIRS). */
export const SCREENSHOT_DIR = join(TMP_ROOT, "serve-sim-screenshots");
/** Protected (see TCC_PROTECTED_DIRS), so only child processes ever name a path under it. */
export const DESKTOP_DIR = join(homedir(), "Desktop");

/**
 * macOS gates these behind a consent prompt. Opening one on a host with nobody to answer that
 * prompt blocks in the kernel and never returns, and the block cannot be detected or timed out.
 * So this process never opens one: ConfinedPath refuses these lexically, and the Desktop copy in
 * screenshot-store runs in a child. Compared case-insensitively: the root volume folds case, so
 * "/users/x/desktop" opens the same directory as "/Users/x/Desktop".
 */
const TCC_PROTECTED_DIRS = [
  DESKTOP_DIR,
  join(homedir(), "Documents"),
  join(homedir(), "Downloads"),
].map((dir) => dir.toLowerCase());

// Only names the refusal. The allowlist below is what refuses spellings this list does not know,
// such as the /System/Volumes/Data firmlink.
function leadsIntoProtectedLocation(path: string): boolean {
  const folded = path.toLowerCase();
  return TCC_PROTECTED_DIRS.some((dir) => folded === dir || folded.startsWith(dir + sep));
}

// Each root in the spelling a caller sends and in its realpath, because a path is compared lexically
// before it is canonicalized. None may sit under TCC_PROTECTED_DIRS: a path under a root is opened.
const ALLOWED_ROOTS = [
  ...new Set(
    [
      join(homedir(), "Library", "Developer", "CoreSimulator", "Devices"),
      // Apple's own apps live in the runtime root, not under a device's data container.
      "/Library/Developer/CoreSimulator",
      join(tmpdir(), basename(UPLOAD_DIR)),
      join(tmpdir(), basename(SCREENSHOT_DIR)),
      UPLOAD_DIR,
      SCREENSHOT_DIR,
    ].flatMap((root) => [root, realpathOrSelf(root)]),
  ),
];

/** A value passed straight to a program: a leading "-" would be read as a flag. */
export const Argument = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{C}]+$/u, "must not contain control characters")
  .refine((v) => !v.startsWith("-"), 'must not start with "-"');

// A dangling link would otherwise fall back to its directory's realpath plus its own name, and the
// final allowlist check would pass a target it never saw.
function isDanglingLink(path: string): boolean {
  try {
    lstatSync(path);
  } catch {
    return false;
  }
  try {
    realpathSync(path);
    return false;
  } catch {
    return true;
  }
}

function isUnderAllowedRoot(path: string): boolean {
  return ALLOWED_ROOTS.some((root) => path === root || path.startsWith(root + sep));
}

/**
 * A caller-named path, confined to ALLOWED_ROOTS: everything the preview legitimately touches is a
 * simulator app container, a screenshot this server took, or a file it staged. Decided on the
 * resolved string before anything is canonicalized, because canonicalizing opens the path and
 * opening a TCC_PROTECTED_DIRS entry on a host with nobody to answer the consent prompt never
 * returns. Only a path already known to sit under an allowed root is opened, and its canonical form
 * is checked again so a symlink under a root cannot point elsewhere.
 */
const OUTSIDE_ROOTS = "is outside the paths this preview may read";

export const ConfinedPath = Argument.refine(
  (value) => !leadsIntoProtectedLocation(resolve(value)),
  { error: "is inside a location this host protects", abort: true },
)
  .refine((value) => isUnderAllowedRoot(resolve(value)), {
    error: OUTSIDE_ROOTS,
    // zod runs every refine even after one fails, and the next one touches the filesystem.
    abort: true,
  })
  .refine((value) => !isDanglingLink(resolve(value)), "is a link this server cannot follow")
  .transform((value) => {
    const full = resolve(value);
    try {
      return realpathSync(full);
    } catch {
      // The leaf may not exist yet (an upload target, a screenshot about to be written); canonicalize
      // the directory so a path under a symlinked root still lands under its real root.
      try {
        return join(realpathSync(dirname(full)), basename(full));
      } catch {
        return full;
      }
    }
  })
  .refine(isUnderAllowedRoot, OUTSIDE_ROOTS);
