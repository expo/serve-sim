import { Vector3, type Box3 } from "three";
import type { DeviceKitChromeDescriptor } from "../utils/grid";

export type DuoDeviceControl = "volume" | "power";
export type DuoControlChrome = Pick<DeviceKitChromeDescriptor, "screen" | "buttons">;

/** Controls attach to the right panel. The inner display's native chrome is
 * rotated clockwise 90 degrees relative to the model, just like its pixels.
 */
export function duoDeviceControlAnchors(bounds: Box3, chrome?: DuoControlChrome | null) {
  const size = bounds.getSize(new Vector3());
  const point = (x: number, y: number) => new Vector3(bounds.min.x + x * size.x, bounds.min.y + y * size.y, bounds.max.z);
  const nativePoint = (names: string[], fallback: Vector3) => {
    if (!chrome || !chrome.screen.width || !chrome.screen.height) return fallback;
    const buttons = names.map((name) => chrome.buttons.find((button) => button.name === name));
    if (buttons.some((button) => !button)) return fallback;
    const x = buttons.reduce((sum, button) => sum + button!.frame.x + button!.frame.width / 2, 0) / buttons.length;
    const y = buttons.reduce((sum, button) => sum + button!.frame.y + button!.frame.height / 2, 0) / buttons.length;
    return point(1 - (y - chrome.screen.y) / chrome.screen.height, 1 - (x - chrome.screen.x) / chrome.screen.width);
  };
  return {
    volume: { point: nativePoint(["volume-up", "volume-down"], point(0.814, 1)), normal: new Vector3(0, 1, 0) },
    power: { point: nativePoint(["power"], point(1, 0.63)), normal: new Vector3(1, 0, 0) },
  };
}
