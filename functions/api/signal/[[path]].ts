import {
  proxyPrivateRequest,
  type PrivateProxyDependencies,
  type PrivateProxyEnv,
} from "../../_lib/private-proxy.ts";

export interface SignalFunctionContext { request: Request; env: PrivateProxyEnv; params: { path?: string | string[] } }

export const handleSignalRequest = (
  context: SignalFunctionContext,
  dependencies: PrivateProxyDependencies = {},
) => proxyPrivateRequest(
  context,
  "signal",
  Array.isArray(context.params.path) ? context.params.path.join("/") : context.params.path ?? "",
  dependencies,
);

export const onRequest = (context: SignalFunctionContext) => handleSignalRequest(context);
