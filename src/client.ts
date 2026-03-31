import {
  initLogger,
  type Logger as BraintrustSdkLogger,
  type Span as BraintrustSdkSpan,
} from "braintrust";
import type { Logger, TraceConfig } from "./types.ts";
import { toUnixSeconds } from "./utils.ts";

export type BraintrustSpanHandle = BraintrustSdkSpan;

export interface StartTraceSpanArgs {
  spanId: string;
  rootSpanId: string;
  parentSpanId?: string;
  name: string;
  type: "task" | "llm" | "tool";
  startedAt: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, number | undefined>;
}

export interface UpdateTraceSpanArgs {
  id: string;
  spanId?: string;
  rootSpanId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, number | undefined>;
}

function compactRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export class BraintrustClient {
  readonly config: TraceConfig;
  readonly logger?: Logger;
  sdkLogger?: BraintrustSdkLogger<true>;
  initPromise?: Promise<void>;

  constructor(config: TraceConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
  }

  #ensureLogger(): BraintrustSdkLogger<true> {
    if (this.sdkLogger) return this.sdkLogger;

    if (this.config.apiUrl && !process.env.BRAINTRUST_API_URL) {
      process.env.BRAINTRUST_API_URL = this.config.apiUrl;
    }

    this.sdkLogger = initLogger({
      projectName: this.config.projectName,
      apiKey: this.config.apiKey,
      appUrl: this.config.appUrl,
      orgName: this.config.orgName,
      asyncFlush: true,
      setCurrent: false,
      debugLogLevel: this.config.debug ? "debug" : false,
    });

    return this.sdkLogger;
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.#doInitialize();
    }
    return this.initPromise;
  }

  async #doInitialize(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("BRAINTRUST_API_KEY is not set");
    }

    const sdkLogger = this.#ensureLogger();
    await sdkLogger.id;
    const project = await sdkLogger.project;
    this.logger?.info("braintrust sdk logger initialized", {
      appUrl: this.config.appUrl,
      apiUrl: this.config.apiUrl,
      project: project.name,
      projectId: project.id,
    });
  }

  startSpan(args: StartTraceSpanArgs): BraintrustSpanHandle | undefined {
    try {
      const sdkLogger = this.#ensureLogger();
      const span = sdkLogger.startSpan({
        spanId: args.spanId,
        parentSpanIds: args.parentSpanId
          ? {
              spanId: args.parentSpanId,
              rootSpanId: args.rootSpanId,
            }
          : undefined,
        name: args.name,
        type: args.type,
        startTime: toUnixSeconds(args.startedAt),
        event: compactRecord({
          input: args.input,
          output: args.output,
          error: args.error,
          metadata: args.metadata,
          metrics: args.metrics,
        }),
      });
      return span;
    } catch (error) {
      this.logger?.error("failed to start Braintrust span", {
        error: String(error),
        spanId: args.spanId,
        parentSpanId: args.parentSpanId,
        rootSpanId: args.rootSpanId,
        name: args.name,
        type: args.type,
      });
      return undefined;
    }
  }

  logSpan(span: BraintrustSpanHandle | undefined, event: Omit<UpdateTraceSpanArgs, "id">): void {
    if (!span) return;

    try {
      span.log(
        compactRecord({
          input: event.input,
          output: event.output,
          error: event.error,
          metadata: event.metadata,
          metrics: event.metrics,
        }),
      );
    } catch (error) {
      this.logger?.error("failed to log Braintrust span", {
        error: String(error),
        spanId: span.spanId,
        rootSpanId: span.rootSpanId,
      });
    }
  }

  endSpan(span: BraintrustSpanHandle | undefined, endedAt = Date.now()): void {
    if (!span) return;

    try {
      span.end({ endTime: toUnixSeconds(endedAt) });
    } catch (error) {
      this.logger?.error("failed to end Braintrust span", {
        error: String(error),
        spanId: span.spanId,
        rootSpanId: span.rootSpanId,
      });
    }
  }

  updateSpan(args: UpdateTraceSpanArgs): void {
    try {
      const sdkLogger = this.#ensureLogger();
      sdkLogger.updateSpan({
        id: args.id,
        span_id: args.spanId,
        root_span_id: args.rootSpanId,
        input: args.input,
        output: args.output,
        error: args.error,
        metadata: args.metadata,
        metrics: args.metrics,
      });
    } catch (error) {
      this.logger?.error("failed to update Braintrust span", {
        error: String(error),
        id: args.id,
        spanId: args.spanId,
        rootSpanId: args.rootSpanId,
      });
    }
  }

  async flush(): Promise<void> {
    const sdkLogger = this.sdkLogger;
    if (!sdkLogger) return;

    try {
      await sdkLogger.flush();
    } catch (error) {
      this.logger?.error("failed to flush Braintrust logs", {
        error: String(error),
      });
    }
  }
}
