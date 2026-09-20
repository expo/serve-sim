import { expect, test } from "bun:test";
import { HingeRequestQueue } from "../client/utils/hinge-request-queue";

test("rapid reversal keeps exactly the last angle behind the in-flight request", () => {
  const sent: number[] = [];
  const settled: boolean[] = [];
  const queue = new HingeRequestQueue((angle) => { sent.push(angle); return true; }, (_, idle) => settled.push(idle));
  for (const angle of [30, 70, 150, 120, 90]) queue.request(angle);
  expect(sent).toEqual([30]);
  queue.acknowledge({ ok: true, angle: 70 }); // another client's acknowledgement
  expect(sent).toEqual([30]);
  queue.acknowledge({ ok: true, angle: 30 });
  expect(sent).toEqual([30, 90]);
  expect(settled).toEqual([false]);
  queue.acknowledge({ ok: true, angle: 90 });
  expect(settled).toEqual([false, true]);
  queue.cancel();
});
test("timeout clears the queued gesture and permits a new preset", async () => {
  const results: boolean[] = [];
  const queue = new HingeRequestQueue(() => true, (result) => results.push(result.ok), 5);
  queue.request(70); queue.request(120);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(results).toEqual([false]);
  queue.request(180); queue.acknowledge({ ok: true, angle: 180 });
  expect(results).toEqual([false, true]);
  queue.cancel();
});
test("failed send settles immediately", () => {
  const errors: boolean[] = [];
  const queue = new HingeRequestQueue(() => false, (result, idle) => errors.push(!result.ok && idle));
  queue.request(90);
  expect(errors).toEqual([true]);
  queue.cancel();
});
