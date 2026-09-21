/** Validate before opening a device session or allocating a panel capture. */
export function panelRouteError(screenId: string | number, endpoint: string, method: string | undefined) {
  if (!["1", "3"].includes(String(screenId))) return { status: 400, error: "invalid_panel" };
  if (!["stream.mjpeg", "stream.avcc", "webrtc/offer", "webrtc/close", "webrtc/stats"].includes(endpoint)) {
    return { status: 404, error: "unknown_panel_endpoint" };
  }
  const expectedMethod = endpoint === "webrtc/offer" || endpoint === "webrtc/close" ? "POST" : "GET";
  if (method !== "OPTIONS" && method !== expectedMethod) return { status: 405, error: "method_not_allowed" };
  return null;
}
