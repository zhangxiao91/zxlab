import { proxyRiskMarket, type RiskMarketFunctionContext } from "../../../_lib/market/proxy";

export const onRequest = (context: RiskMarketFunctionContext) => proxyRiskMarket(context);
