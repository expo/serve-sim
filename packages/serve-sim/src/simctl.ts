import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export interface SimctlOptions {
  /** Milliseconds before the command is killed. */
  timeout?: number;
  /** Merged over the current environment, for callers that need a locale or a child insert. */
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

/**
 * Run `xcrun simctl` and resolve its stdout untrimmed, so callers that carry
 * user data (pbpaste) keep leading and trailing whitespace. A failure throws
 * with simctl's own stderr as the message, which says more than the exit code.
 */
export async function simctl(args: string[], options: SimctlOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  }).catch((error: unknown) => {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw stderr ? new Error(stderr) : error;
  });
  return stdout;
}

/** Synchronous variant, for setup and teardown paths that cannot await. */
export function simctlSync(args: string[], options: SimctlOptions = {}): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
}
