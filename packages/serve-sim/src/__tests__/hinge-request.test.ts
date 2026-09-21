import { afterEach, expect, mock, test } from "bun:test";
import { completeHingeRequest, type PendingHingeRequest } from "../client/utils/hinge-request";

const timers: ReturnType<typeof setTimeout>[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
});

function request(angle = 90) {
  const onTimeout = mock(() => {});
  const pending: PendingHingeRequest = { angle, timer: setTimeout(onTimeout, 20) };
  timers.push(pending.timer);
  return { pending, onTimeout };
}

test.each([undefined, 180])("a rejection with angle %s immediately completes the request with the server error", async (angle) => {
  const { pending, onTimeout } = request();
  const completed = completeHingeRequest(pending, { ok: false, angle, error: "Hinge angle must be between 0 and 180" });
  expect(completed).toEqual({ error: "Hinge angle must be between 0 and 180", angle: undefined });
  await Bun.sleep(30);
  expect(onTimeout).not.toHaveBeenCalled();
});

test("a rejection without an error message uses the simulator failure message", () => {
  const { pending } = request();
  expect(completeHingeRequest(pending, { ok: false })).toEqual({
    error: "Simulator could not change the hinge angle.",
    angle: undefined,
  });
});

test("a matching successful reply completes the request and cancels its timeout", async () => {
  const { pending, onTimeout } = request();
  expect(completeHingeRequest(pending, { ok: true, angle: 90 })).toEqual({ error: null, angle: 90 });
  await Bun.sleep(30);
  expect(onTimeout).not.toHaveBeenCalled();
});

test("an unrelated successful reply leaves the request and its timeout pending", async () => {
  const { pending, onTimeout } = request();
  expect(completeHingeRequest(pending, { ok: true, angle: 180 })).toBeNull();
  expect(completeHingeRequest(pending, { ok: true })).toBeNull();
  await Bun.sleep(30);
  expect(onTimeout).toHaveBeenCalledTimes(1);
});

test("unsolicited replies do not change the control state", () => {
  expect(completeHingeRequest(null, { ok: false, error: "Invalid angle" })).toBeNull();
  expect(completeHingeRequest(null, { ok: true, angle: 90 })).toBeNull();
});
