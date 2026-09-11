import { expect, test } from "bun:test";
import { createCrashDetailController } from "../client/utils/crash-detail";
import { parseCrashReport } from "../crash/report";
import { CrashStore } from "../crash/store";
import { summarizeCrash, type CrashDetailResponse } from "../crash/protocol";

function harness() {
  const store = new CrashStore();
  const report = parseCrashReport('{"bundleID":"demo","incident_id":"A"}\n{}')!;
  for (let i = 0; i < 3; i += 1) store.record(report, `/${i}.ips`);
  const record = store.list()[0]!;
  const summary = summarizeCrash(record);
  const requests: { index: number | undefined; signal: AbortSignal; reply: ReturnType<typeof Promise.withResolvers<CrashDetailResponse>> }[] = [];
  const controller = createCrashDetailController((_id, index, signal) => {
    const reply = Promise.withResolvers<CrashDetailResponse>();
    requests.push({ index, signal, reply });
    return reply.promise;
  }, () => {});
  controller.sync([summary]);
  const response = (index: number): CrashDetailResponse => ({
    record: summary, occurrence: { ...record.occurrences[index]!, index, total: 3 },
    report: "report", reportError: null,
  });
  return { controller, requests, response, summary };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("rapid paging aborts older requests and ignores their late replies", async () => {
  const { controller, requests, response } = harness();
  const first = controller.load("A");
  requests[0]!.reply.resolve(response(2));
  await first;
  expect(controller.step(-1)).toBe(true);
  expect(controller.step(-1)).toBe(true);
  expect(requests.map((request) => request.index)).toEqual([undefined, 1, 0]);
  expect(requests[1]!.signal.aborted).toBe(true);
  requests[2]!.reply.resolve(response(0));
  await flush();
  requests[1]!.reply.resolve(response(1));
  await flush();
  expect(controller.snapshot().detail?.occurrence.index).toBe(0);
  expect(controller.snapshot().pendingIndex).toBe(0);
  controller.dispose();
});

test("a failed page returns navigation to the occurrence still displayed", async () => {
  const { controller, requests, response } = harness();
  const first = controller.load("A");
  requests[0]!.reply.resolve(response(2));
  await first;
  controller.select(1);
  requests[1]!.reply.reject(new Error("offline"));
  await flush();
  expect(controller.snapshot().pendingIndex).toBe(2);
  expect(controller.snapshot().detail?.occurrence.index).toBe(2);
  expect(controller.snapshot().error).toContain("Try selecting it again");
  controller.dispose();
});

test("retention remaps the displayed occurrence and paging cursor together", async () => {
  const { controller, requests, response, summary } = harness();
  const first = controller.load("A");
  requests[0]!.reply.resolve(response(2));
  await first;
  controller.sync([{ ...summary, count: 4, occurrenceCount: 2, occurrenceTimes: summary.occurrenceTimes.slice(1) }]);
  expect(controller.snapshot().detail?.occurrence).toMatchObject({ rawPath: "/2.ips", index: 1, total: 2 });
  expect(controller.snapshot().pendingIndex).toBe(1);
  expect(requests).toHaveLength(1);
  controller.dispose();
});

test("an aged-out occurrence reloads only once even if its replacement fails", async () => {
  const { controller, requests, response, summary } = harness();
  const first = controller.load("A", 0);
  requests[0]!.reply.resolve(response(0));
  await first;
  const next = { ...summary, count: 4, occurrenceCount: 2, occurrenceTimes: summary.occurrenceTimes.slice(1) };
  controller.sync([next]);
  expect(requests[1]!.index).toBe(1);
  requests[1]!.reply.reject(new Error("offline"));
  await flush();
  controller.sync([next]);
  expect(requests).toHaveLength(2);
  controller.dispose();
});

test("closing or disposing an in-flight detail prevents a late response from reopening it", async () => {
  for (const action of ["close", "dispose"] as const) {
    const { controller, requests, response } = harness();
    const first = controller.load("A");
    controller[action]();
    requests[0]!.reply.resolve(response(2));
    await first;
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(controller.snapshot().detail).toBeNull();
  }
});
