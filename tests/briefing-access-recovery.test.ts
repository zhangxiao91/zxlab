import assert from "node:assert/strict";
import test from "node:test";
import { accessRecoveryPresentation } from "../src/features/briefing/access-recovery.ts";

function signalError(code: string, message: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

test("Access recovery keeps an actionable login path when the browser session is still unavailable", () => {
  assert.deepEqual(
    accessRecoveryPresentation(signalError("SIGNAL_ACCESS_REQUIRED", "login required", 401)),
    {
      kind: "access-required",
      message: "Cloudflare Access 尚未在当前标签页生效。请重新授权，或改用当前标签页完成登录。",
      showAccessActions: true,
    },
  );
});

test("Access recovery also recognizes application-level Access rejection", () => {
  assert.deepEqual(
    accessRecoveryPresentation(signalError("ACCESS_REQUIRED", "login required", 401)),
    {
      kind: "access-required",
      message: "Cloudflare Access 尚未在当前标签页生效。请重新授权，或改用当前标签页完成登录。",
      showAccessActions: true,
    },
  );
});

test("Access recovery exposes upstream authentication failures instead of asking the user to log in again", () => {
  assert.deepEqual(
    accessRecoveryPresentation(signalError("PRIVATE_UPSTREAM_AUTH_FAILED", "Private service authentication failed.", 502)),
    {
      kind: "upstream-auth-failed",
      message: "Cloudflare Access 已通过，但 Pages 与私有服务之间的鉴权失败。请稍后重试；若持续出现，需要检查服务端配置。",
      showAccessActions: false,
    },
  );
});

test("Access recovery preserves ordinary probe errors with their real code and message", () => {
  assert.deepEqual(
    accessRecoveryPresentation(signalError("WATCH_STORE_UNAVAILABLE", "Watch store is unavailable", 503)),
    {
      kind: "probe-failed",
      message: "授权返回后验证失败（WATCH_STORE_UNAVAILABLE）：Watch store is unavailable",
      showAccessActions: false,
    },
  );
});
