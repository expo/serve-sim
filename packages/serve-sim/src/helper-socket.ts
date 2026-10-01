import { existsSync } from "fs";

const HELPER_TIMEOUT_MS = 3000;

export interface HelperReply {
  [key: string]: unknown;
  ok?: boolean;
  error?: string;
}

function parseHelperReply(value: unknown): HelperReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid helper reply");
  }
  return value as HelperReply;
}

/**
 * Sends one newline-delimited JSON command to a host helper's control socket
 * and resolves with its first reply line. Shared by the camera and mic helpers.
 */
export async function sendHelperSocketCommand(
  socketPath: string,
  command: object,
  timeoutMs = HELPER_TIMEOUT_MS,
): Promise<HelperReply> {
  if (!existsSync(socketPath)) throw new Error("helper socket not found");
  const net = await import("net");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (error?: unknown, reply?: HelperReply) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(reply ?? {});
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        settle(undefined, parseHelperReply(JSON.parse(buffer.slice(0, newline)) as unknown));
      } catch (error) {
        settle(error);
      }
      socket.end();
    });
    socket.on("error", settle);
    socket.on("close", () => settle(new Error("socket closed")));
    timeout = setTimeout(() => {
      socket.destroy();
      settle(new Error("helper timeout"));
    }, timeoutMs);
    socket.write(JSON.stringify(command) + "\n");
  });
}
