import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseProxyArguments, runAccessProxy } from "./zxlab-debug-request.mjs";

test("debug operations are enumerated and arbitrary requests are rejected", () => {
  assert.deepEqual(parseProxyArguments([]), ["profile"]);
  assert.deepEqual(parseProxyArguments(["today"]), ["today"]);
  assert.deepEqual(parseProxyArguments(["run-create", "--instrument", "SSE:600000"]), ["run-create", "--instrument", "SSE:600000"]);
  assert.throws(() => parseProxyArguments(["--method", "DELETE", "--path", "/api/private/market-agent/runs/1"]), /Unknown operation/);
  assert.throws(() => parseProxyArguments(["profile", "--url", "https://example.com"]), /does not accept/);
  assert.throws(() => parseProxyArguments(["run-status", "--run-id", "id", "--body", "{}"]), /requires/);
});

test("Node receives only the native proxy JSON summary", () => {
  const result = runAccessProxy(["profile"], (binary, arguments_, options) => {
    assert.match(binary, /scripts\/\.bin\/zxlab-access-proxy$/);
    assert.deepEqual(arguments_, ["profile"]);
    assert.equal(options.stdio[0], "inherit");
    return { status: 0, stdout: '{"ok":true,"httpStatus":200,"bootstrap":"complete"}\n', stderr: "" };
  }, () => true);
  assert.deepEqual(result, { ok: true, httpStatus: 200, bootstrap: "complete" });
});

test("native proxy compiles and its allowlist self-test passes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zxlab-access-proxy-test-"));
  try {
    const binary = join(directory, "zxlab-access-proxy");
    const build = spawnSync("/bin/zsh", ["scripts/build-zxlab-access-proxy.sh", binary], { encoding: "utf8", timeout: 60_000 });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const selfTest = spawnSync(binary, ["self-test"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
    assert.deepEqual(JSON.parse(selfTest.stdout), { ok: true, tests: 5 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
