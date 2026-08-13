export type AccessRecoveryKind = "access-required" | "upstream-auth-failed" | "probe-failed";

export interface AccessRecoveryPresentation {
  kind: AccessRecoveryKind;
  message: string;
  showAccessActions: boolean;
}

interface SignalErrorLike extends Error {
  code: string;
  status?: number;
}

function signalError(error: unknown): error is SignalErrorLike {
  return error instanceof Error && typeof (error as Partial<SignalErrorLike>).code === "string";
}

export function accessRecoveryPresentation(error: unknown): AccessRecoveryPresentation {
  if (signalError(error) && (error.code === "SIGNAL_ACCESS_REQUIRED" || error.code === "ACCESS_REQUIRED")) {
    return {
      kind: "access-required",
      message: "Cloudflare Access 尚未在当前标签页生效。请重新授权，或改用当前标签页完成登录。",
      showAccessActions: true,
    };
  }

  if (signalError(error) && error.code === "PRIVATE_UPSTREAM_AUTH_FAILED") {
    return {
      kind: "upstream-auth-failed",
      message: "Cloudflare Access 已通过，但 Pages 与私有服务之间的鉴权失败。请稍后重试；若持续出现，需要检查服务端配置。",
      showAccessActions: false,
    };
  }

  const code = signalError(error) ? error.code : "SIGNAL_ACCESS_PROBE_FAILED";
  const message = error instanceof Error ? error.message : "无法确认私有 Signal 服务是否可用";
  return {
    kind: "probe-failed",
    message: `授权返回后验证失败（${code}）：${message}`,
    showAccessActions: false,
  };
}
