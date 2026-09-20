export function matchesPanelFrame(width: number, height: number, aspect?: number): boolean {
  if (!aspect) return true;
  return Math.abs(Math.min(width, height) / Math.max(width, height) - Math.min(aspect, 1 / aspect)) < 0.005;
}
