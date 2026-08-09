import type { ReactNode } from "react";

export type TradingStatusTone = "live" | "degraded" | "offline" | "neutral";

export interface TradingScreenStatus {
  tone: TradingStatusTone;
  label: string;
  detail?: string;
}

export interface TradingScreenAction {
  label: string;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  invoke(): void | Promise<void>;
}

export interface TradingScreenToggle {
  label: string;
  pressed: boolean;
  disabled?: boolean;
  invoke(): void | Promise<void>;
}

export interface TradingDialogProjection {
  title: string;
  description?: string;
  size?: "compact" | "wide";
  content: ReactNode;
}

export interface TradingScreenProjection {
  content: ReactNode;
  status?: TradingScreenStatus;
  primaryAction?: TradingScreenAction;
  secondaryToggle?: TradingScreenToggle;
  dialog?: TradingDialogProjection;
}

export type TradingScreenRenderer = (
  projection: TradingScreenProjection,
) => ReactNode;
