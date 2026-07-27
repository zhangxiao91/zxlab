import { proxyPrivateRequest, type PrivateProxyEnv } from "../../../_lib/private-proxy.ts";

interface FunctionContext { request: Request; env: PrivateProxyEnv; params: { path?: string | string[] } }

export const onRequest = (context: FunctionContext) => proxyPrivateRequest(
  context,
  "signal",
  Array.isArray(context.params.path) ? context.params.path.join("/") : context.params.path ?? "",
);
