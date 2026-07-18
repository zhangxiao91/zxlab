import type { SignalSourceType } from "@zxlab/signal-schema";
import type { SignalSourceConfig } from "../config/sources";

export interface CollectionContext {
  runId: string;
  now: string;
  since?: string;
}

export interface RawCollectedItem {
  externalId: string;
  title: string;
  url: string;
  summary?: string;
  contentText?: string;
  authorName?: string;
  authorUrl?: string;
  publishedAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SignalCollector {
  type: SignalSourceType;
  collect(source: SignalSourceConfig, context: CollectionContext): Promise<RawCollectedItem[]>;
}
