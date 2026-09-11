import type { IncomingMessage, ServerResponse } from "node:http";

const SSE_HEARTBEAT_MS = 15_000;

/** `isOpen` is the `writableEnded`/`destroyed` pair: an aborted client only sets the latter. */
export function openSseStream(
  req: IncomingMessage,
  res: ServerResponse
): { isOpen: () => boolean; write: (payload: string) => void; onClose: (teardown: () => void) => void } {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  const isOpen = (): boolean => !res.writableEnded && !res.destroyed;
  const heartbeat = setInterval(() => {
    if (isOpen()) res.write(":\n\n");
  }, SSE_HEARTBEAT_MS);
  let closed = false;
  const teardowns: (() => void)[] = [];
  const closeAll = (): void => {
    closed = true;
    clearInterval(heartbeat);
    while (teardowns.length > 0) teardowns.pop()!();
  };
  req.on("close", closeAll);
  // A client that left during the caller's await already fired `close`, so run teardown now.
  if (req.destroyed || res.destroyed) closeAll();

  return {
    isOpen,
    write: (payload) => {
      if (isOpen()) res.write(payload);
    },
    onClose: (teardown) => (closed ? teardown() : teardowns.push(teardown)),
  };
}
