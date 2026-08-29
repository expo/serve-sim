type PreviewLocation = Pick<Location, "hostname" | "search">;

export function shouldStreamSimulatorLogs(location: PreviewLocation): boolean {
  return new URLSearchParams(location.search).get("logs") === "1";
}
