import { SpanStatusCode, type Span, type Attributes } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { WorkEvent, WorkObserver, SessionEvent } from "../adapters.js";
import type { AgentConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ForemanPlugin, PluginContext, PluginCatalogEntry } from "./contract.js";

const ENDPOINT_VARS = ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"] as const;
const FLUSH_MS = 3000;

/** True when an OTLP destination is set in the standard environment variables. */
export function otelEndpointSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENDPOINT_VARS.some((k) => (env[k] ?? "").trim() !== "");
}

/**
 * Wraps the OTLP exporter to log its failures once per outage (and the recovery), never
 * the message's headers or URL userinfo: only the error's own text is logged, redacted.
 */
export class OutageLoggingExporter implements SpanExporter {
  private failing = false;
  constructor(private readonly inner: SpanExporter, private readonly logger: Logger) {}
  export(spans: ReadableSpan[], done: (r: { code: number; error?: Error }) => void): void {
    try {
      this.inner.export(spans, (r) => {
        if (r.code === 0) {
          if (this.failing) { this.failing = false; this.logger.warn("otel: export recovered"); }
        } else if (!this.failing) {
          this.failing = true;
          this.logger.warn(`otel: export failed: ${redact(r.error?.message ?? "unknown error")}`);
        }
        done(r);
      });
    } catch (err) {
      if (!this.failing) { this.failing = true; this.logger.warn(`otel: export failed: ${redact(err instanceof Error ? err.message : String(err))}`); }
      done({ code: 1 });
    }
  }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  forceFlush(): Promise<void> { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}

/** Drops URL userinfo and anything that looks like a header value from an error text. */
function redact(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//").replace(/(authorization|api[-_]?key|token)[=:]\s*\S+/gi, "$1=…");
}

const sessionKey = (s: SessionEvent): string => `${s.repo}|${s.phase}|${s.pr ?? ""}|${s.items.map((i) => i.issueNumber).sort((a, b) => a - b).join(",")}`;

/** The observer: one span per session, one zero-length trace per lifecycle event. Never throws, never awaits an export. */
export class OtelObserver implements WorkObserver {
  private readonly started = new Map<string, number>();
  /** The PR each item's `prLink` named: the production implement envelope carries no `pr`. */
  private readonly prByItem = new Map<string, number>();
  constructor(private readonly provider: BasicTracerProvider, private readonly serviceName: string) {}

  private tracer() { return this.provider.getTracer(this.serviceName); }

  async onEvent(event: WorkEvent, logger: Logger): Promise<void> {
    try {
      if (event.kind === "prLink") {
        const n = /\/pull\/(\d+)/.exec(event.prUrl)?.[1];
        if (n) this.prByItem.set(`${event.item.repo}#${event.item.issueNumber}`, Number(n));
      } else if (event.kind === "session") this.session(event.session);
      else if (event.kind === "claim" || event.kind === "transition" || event.kind === "blocked" || event.kind === "unblocked" || event.kind === "escalated" || event.kind === "merged" || event.kind === "promoted") {
        this.point(event.kind, event.item.repo, event.item.issueNumber);
      } else if (event.kind === "release") {
        for (const i of event.release.issues) this.point("release", event.release.repo, i.issueNumber, { "foreman.release.state": event.release.state });
      }
    } catch (err) {
      logger.warn(`otel: could not record ${event.kind}: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private point(kind: string, repo: string, item: number, extra: Attributes = {}): void {
    const span = this.tracer().startSpan(`foreman.item.${kind}`, { root: true, attributes: { "foreman.repo": repo, "foreman.item": item, ...extra } });
    span.end();
  }

  private session(s: SessionEvent): void {
    const key = sessionKey(s);
    if (s.status === "started") { this.started.set(key, Date.now()); return; }
    const start = this.started.get(key);
    const attrs: Attributes = {
      "foreman.phase": s.phase, "foreman.status": s.status, "foreman.repo": s.repo,
      "foreman.items": s.items.map((i) => i.issueNumber),
    };
    const pr = s.pr ?? s.report?.pr?.number ?? this.linkedPr(s);
    if (pr !== undefined) attrs["foreman.pr"] = pr;
    if (s.reviewer) attrs["foreman.reviewer"] = s.reviewer;
    if (s.worked) attrs["foreman.items.worked"] = [...s.worked];
    else if (s.phase === "implement") attrs["foreman.items.candidates"] = true;
    if (start === undefined) attrs["foreman.start_missing"] = true;
    if (s.status === "handoff") {
      // A handoff is an event on the still-open session, kept in memory until it ends; with no open record, a point span.
      const open = this.open.get(key) ?? this.begin(key, s, start);
      open.addEvent("foreman.handoff", s.reviewer ? { "foreman.reviewer": s.reviewer } : {});
      return;
    }
    const span = this.open.get(key) ?? this.begin(key, s, start);
    this.open.delete(key);
    this.started.delete(key);
    for (const i of s.items) this.prByItem.delete(`${s.repo}#${i.issueNumber}`);
    span.setAttributes(attrs);
    if (s.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  }

  private linkedPr(s: SessionEvent): number | undefined {
    const ids = s.worked ?? s.items.map((i) => i.issueNumber);
    for (const n of ids) { const pr = this.prByItem.get(`${s.repo}#${n}`); if (pr !== undefined) return pr; }
    return undefined;
  }

  async flush(): Promise<void> { await this.provider.forceFlush(); }

  private readonly open = new Map<string, Span>();
  private begin(key: string, s: SessionEvent, start: number | undefined): Span {
    const span = this.tracer().startSpan(`foreman.session.${s.phase}`, { root: true, startTime: start ?? Date.now() });
    this.open.set(key, span);
    return span;
  }
}

/**
 * OpenTelemetry: an observer that exports one trace per agent session over OTLP/HTTP (docs/otel.md).
 * Destination and credentials come only from the standard `OTEL_EXPORTER_OTLP_*` variables.
 */
export class OtelPlugin implements ForemanPlugin {
  readonly id = "otel";
  readonly roles = ["observer"] as const;
  readonly catalog: PluginCatalogEntry = {
    name: "OpenTelemetry",
    purpose: "Exports one trace per agent session to an OpenTelemetry-compatible tool you choose.",
    onWhen: "`otel.enabled`",
    requires: { config: ["otel.enabled", "otel.serviceName"], env: ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"] },
    whenOff: "Nothing is exported and no OTEL_* variable is read; the lifecycle is unchanged.",
  };
  private provider: BasicTracerProvider | null = null;
  private obs: OtelObserver | null = null;
  private name: string | null = null;

  get observer(): WorkObserver | undefined { return this.obs ?? undefined; }

  enabled(config: AgentConfig): boolean { return config.otel?.enabled === true; }

  start(config: AgentConfig, ctx: PluginContext): void {
    this.name = config.otel.serviceName;
    if (!otelEndpointSet()) {
      ctx.logger.warn("otel: enabled but no OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT is set; nothing is exported");
      return;
    }
    try {
      const exporter = new OutageLoggingExporter(new OTLPTraceExporter(), ctx.logger);
      this.provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ "service.name": this.name }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      this.obs = new OtelObserver(this.provider, this.name);
      ctx.logger.info(`OpenTelemetry on: service ${this.name}`);
    } catch (err) {
      this.provider = null; this.obs = null;
      ctx.logger.warn(`otel: could not start: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }

  reconfigure(config: AgentConfig, ctx: PluginContext): void {
    if (config.otel.serviceName !== this.name || !this.provider) {
      this.stop();
      this.start(config, ctx);
    }
  }

  stop(): void {
    const p = this.provider;
    this.provider = null; this.obs = null; this.name = null;
    if (p) void Promise.race([p.shutdown(), new Promise((r) => setTimeout(r, FLUSH_MS).unref())]).catch(() => undefined);
  }
}

