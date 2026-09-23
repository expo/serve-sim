import { expect, test } from "bun:test";
import { onEscapeCapture } from "../client/utils/escape-capture";

const keydown = (key: string): Event => Object.assign(new Event("keydown", { cancelable: true }), { key });

test("an Escape the drawer takes never reaches the window listeners that forward keys", () => {
  const target = new EventTarget();
  const forwarded: string[] = [];
  target.addEventListener("keydown", (event) => forwarded.push((event as Event & { key: string }).key));
  let handled = 0;
  const stop = onEscapeCapture(target, () => (handled += 1));

  const escape = keydown("Escape");
  target.dispatchEvent(escape);
  target.dispatchEvent(keydown("a"));
  stop();
  target.dispatchEvent(keydown("Escape"));

  expect(handled).toBe(1);
  expect(escape.defaultPrevented).toBe(true);
  expect(forwarded).toEqual(["a", "Escape"]);
});
