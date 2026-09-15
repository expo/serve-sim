import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

function runProbe(mode = "ready") {
  const result = spawnSync("python3", [
    resolve(import.meta.dir, "fixtures/ready-retry-probe.py"),
    resolve(import.meta.dir, "../mitm-addon/servesim_capture.py"),
    mode,
  ], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test("addon readiness recovers when the control server rejects its first announcement", () => {
  const probe = runProbe();
  expect(probe.recovered).toBe(true);
  expect(probe.attempts).toEqual([
    { path: "/ready?t=ready-probe", body: { addon: "servesim_capture" } },
    { path: "/ready?t=ready-probe", body: { addon: "servesim_capture" } },
  ]);
});


test("addon readiness stops after its bounded attempt budget", () => {
  const probe = runProbe("unavailable");
  expect(probe.recovered).toBe(false);
  expect(probe.attempts).toHaveLength(5);
});

test("addon does not retry flow records after a control-server error", () => {
  const probe = runProbe("flow");
  expect(probe.attempts).toEqual([{ path: "/request?t=ready-probe", body: { id: "one" } }]);
});
