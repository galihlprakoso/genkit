/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { logger } from '@genkit-ai/core/logging';
import {
  ExporterOptions,
  MetricExporter,
} from '@google-cloud/opentelemetry-cloud-monitoring-exporter';
import { TraceExporter } from '@google-cloud/opentelemetry-cloud-trace-exporter';
import { GcpDetectorSync } from '@google-cloud/opentelemetry-resource-util';
import { Span, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  ExportResult,
  hrTimeDuration,
  hrTimeToMilliseconds,
} from '@opentelemetry/core';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
import { Resource } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  DefaultAggregation,
  ExponentialHistogramAggregation,
  InMemoryMetricExporter,
  InstrumentType,
  PeriodicExportingMetricReader,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  ReadableSpan,
  SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { GENKIT_VERSION } from 'genkit';
import { PathMetadata } from 'genkit/tracing';
import { actionTelemetry } from './telemetry/action.js';
import { engagementTelemetry } from './telemetry/engagement.js';
import { featuresTelemetry } from './telemetry/feature.js';
import { generateTelemetry } from './telemetry/generate.js';
import { pathsTelemetry } from './telemetry/path.js';
import { GcpTelemetryConfig } from './types';
import {
  extractErrorName,
  metricsDenied,
  metricsDeniedHelpText,
  tracingDenied,
  tracingDeniedHelpText,
} from './utils';

let metricExporter: PushMetricExporter;
let spanProcessor: BatchSpanProcessor;
let spanExporter: AdjustingTraceExporter;

/**
 * Provides a {TelemetryConfig} for exporting OpenTelemetry data (Traces,
 * Metrics, and Logs) to the Google Cloud Operations Suite.
 */
export class GcpOpenTelemetry {
  private readonly config: GcpTelemetryConfig;
  private readonly resource: Resource;

  constructor(config: GcpTelemetryConfig) {
    this.config = config;
    this.resource = new Resource({ type: 'global' }).merge(
      new GcpDetectorSync().detect()
    );
  }

  /**
   * Log hook for writing trace and span metadata to log messages in the format
   * required by GCP.
   */
  private gcpTraceLogHook = (span: Span, record: any) => {
    const spanContext = span.spanContext();
    const isSampled = !!(spanContext.traceFlags & TraceFlags.SAMPLED);
    const projectId = this.config.projectId;

    record['logging.googleapis.com/trace'] ??=
      `projects/${projectId}/traces/${spanContext.traceId}`;
    record['logging.googleapis.com/trace_sampled'] ??= isSampled ? '1' : '0';
    record['logging.googleapis.com/spanId'] ??= spanContext.spanId;
  };

  async getConfig(): Promise<Partial<NodeSDKConfiguration>> {
    spanProcessor = new BatchSpanProcessor(await this.createSpanExporter());
    return {
      resource: this.resource,
      spanProcessor: spanProcessor,
      sampler: this.config.sampler,
      instrumentations: this.getInstrumentations(),
      metricReader: await this.createMetricReader(),
    };
  }

  private async createSpanExporter(): Promise<SpanExporter> {
    spanExporter = new AdjustingTraceExporter(
      this.shouldExportTraces()
        ? new TraceExporter({
            // Creds for non-GCP environments; otherwise credentials will be
            // automatically detected via ADC
            credentials: this.config.credentials,
          })
        : new InMemorySpanExporter(),
      this.config.exportIO,
      this.config.projectId,
      getErrorHandler(
        (err) => {
          return tracingDenied(err);
        },
        await tracingDeniedHelpText()
      )
    );
    return spanExporter;
  }

  /**
   * Creates a {MetricReader} for pushing metrics out to GCP via OpenTelemetry.
   */
  private async createMetricReader(): Promise<PeriodicExportingMetricReader> {
    metricExporter = await this.buildMetricExporter();
    return new PeriodicExportingMetricReader({
      exportIntervalMillis: this.config.metricExportIntervalMillis,
      exportTimeoutMillis: this.config.metricExportTimeoutMillis,
      exporter: metricExporter,
    });
  }

  /** Gets all open telemetry instrumentations as configured by the plugin. */
  private getInstrumentations() {
    if (this.config.autoInstrumentation) {
      return getNodeAutoInstrumentations(
        this.config.autoInstrumentationConfig
      ).concat(this.getDefaultLoggingInstrumentations());
    }
    return this.getDefaultLoggingInstrumentations();
  }

  private shouldExportTraces(): boolean {
    return this.config.export && !this.config.disableTraces;
  }

  private shouldExportMetrics(): boolean {
    return this.config.export && !this.config.disableMetrics;
  }

  /** Always configure the Pino and Winston instrumentations */
  private getDefaultLoggingInstrumentations(): Instrumentation[] {
    return [
      new WinstonInstrumentation({ logHook: this.gcpTraceLogHook }),
      new PinoInstrumentation({ logHook: this.gcpTraceLogHook }),
    ];
  }

  private async buildMetricExporter(): Promise<PushMetricExporter> {
    console.log(
      `BUILD METRIC EXPORTER: ${JSON.stringify(this.config.credentials)}`
    );
    const exporter: PushMetricExporter = this.shouldExportMetrics()
      ? new MetricExporterWrapper(
          {
            userAgent: {
              product: 'genkit',
              version: GENKIT_VERSION,
            },
            // Creds for non-GCP environments; otherwise credentials will be
            // automatically detected via ADC
            credentials: this.config.credentials,
          },
          getErrorHandler(
            (err) => {
              return metricsDenied(err);
            },
            await metricsDeniedHelpText()
          )
        )
      : new InMemoryMetricExporter(AggregationTemporality.DELTA);
    exporter.selectAggregation = (instrumentType: InstrumentType) => {
      if (instrumentType === InstrumentType.HISTOGRAM) {
        return new ExponentialHistogramAggregation();
      }
      return new DefaultAggregation();
    };
    exporter.selectAggregationTemporality = (
      instrumentType: InstrumentType
    ) => {
      return AggregationTemporality.DELTA;
    };
    return exporter;
  }
}

/**
 * Rewrites the export method to include an error handler which logs
 * helpful information about how to set up metrics/telemetry in GCP.
 */
class MetricExporterWrapper extends MetricExporter {
  constructor(
    private options?: ExporterOptions,
    private errorHandler?: (error: Error) => void
  ) {
    super(options);
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void
  ): void {
    super.export(metrics, (result) => {
      if (this.errorHandler && result.error) {
        this.errorHandler(result.error);
      }
      resultCallback(result);
    });
  }
}

/**
 * Adjusts spans before exporting to GCP. Redacts model input
 * and output content, and augments span attributes before sending to GCP.
 */
class AdjustingTraceExporter implements SpanExporter {
  constructor(
    private exporter: SpanExporter,
    private logIO: boolean,
    private projectId?: string,
    private errorHandler?: (error: Error) => void
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    this.exporter?.export(this.adjust(spans), (result) => {
      if (this.errorHandler && result.error) {
        this.errorHandler(result.error);
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.exporter?.shutdown();
  }

  getExporter(): SpanExporter {
    return this.exporter;
  }

  forceFlush(): Promise<void> {
    if (this.exporter?.forceFlush) {
      return this.exporter.forceFlush();
    }
    return Promise.resolve();
  }

  private adjust(spans: ReadableSpan[]): ReadableSpan[] {
    const allPaths = spans
      .filter((span) => span.attributes['genkit:path'])
      .map(
        (span) =>
          ({
            path: span.attributes['genkit:path'] as string,
            status:
              (span.attributes['genkit:state'] as string) === 'error'
                ? 'failure'
                : 'success',
            error: extractErrorName(span.events),
            latency: hrTimeToMilliseconds(
              hrTimeDuration(span.startTime, span.endTime)
            ),
          }) as PathMetadata
      );

    const allLeafPaths = new Set<PathMetadata>(
      allPaths.filter((leafPath) =>
        allPaths.every(
          (path) =>
            path.path === leafPath.path ||
            !path.path.startsWith(leafPath.path) ||
            (path.path.startsWith(leafPath.path) &&
              path.status !== leafPath.status)
        )
      )
    );

    return spans.map((span) => {
      this.tickTelemetry(span, allLeafPaths);

      span = this.redactInputOutput(span);
      span = this.markErrorSpanAsError(span);
      span = this.markFailedAction(span);
      span = this.markGenkitFeature(span);
      span = this.markGenkitModel(span);
      span = this.normalizeLabels(span);
      return span;
    });
  }

  private tickTelemetry(span: ReadableSpan, paths: Set<PathMetadata>) {
    const attributes = span.attributes;
    if (!Object.keys(attributes).includes('genkit:type')) {
      return;
    }

    const type = attributes['genkit:type'] as string;
    const subtype = attributes['genkit:metadata:subtype'] as string;
    const isRoot = !!span.attributes['genkit:isRoot'];
    const unused: Set<PathMetadata> = new Set();

    if (isRoot) {
      // Report top level feature request and latency only for root spans
      // Log input to and output from to the feature
      featuresTelemetry.tick(span, unused, this.logIO, this.projectId);
      // Report executions and latency for all flow paths only on the root span
      pathsTelemetry.tick(span, paths, this.logIO, this.projectId);
    }
    if (type === 'action' && subtype === 'model') {
      // Report generate metrics () for all model actions
      generateTelemetry.tick(span, unused, this.logIO, this.projectId);
    }
    if (type === 'action' && subtype === 'tool') {
      // TODO: Report input and output for tool actions
    }
    if (type === 'action' || type === 'flow' || type == 'flowStep') {
      // Report request and latency metrics for all actions
      actionTelemetry.tick(span, unused, this.logIO, this.projectId);
    }
    if (type === 'userEngagement') {
      // Report user acceptance and feedback metrics
      engagementTelemetry.tick(span, unused, this.logIO, this.projectId);
    }
  }

  private redactInputOutput(span: ReadableSpan): ReadableSpan {
    const hasInput = 'genkit:input' in span.attributes;
    const hasOutput = 'genkit:output' in span.attributes;

    return !hasInput && !hasOutput
      ? span
      : {
          ...span,
          spanContext: span.spanContext,
          attributes: {
            ...span.attributes,
            'genkit:input': '<redacted>',
            'genkit:output': '<redacted>',
          },
        };
  }

  // This is a workaround for GCP Trace to mark a span with a red
  // exclamation mark indicating that it is an error.
  private markErrorSpanAsError(span: ReadableSpan): ReadableSpan {
    return span.status.code !== SpanStatusCode.ERROR
      ? span
      : {
          ...span,
          spanContext: span.spanContext,
          attributes: {
            ...span.attributes,
            '/http/status_code': '599',
          },
        };
  }

  // This is a workaround for GCP Trace to mark a span with a red
  // exclamation mark indicating that it is an error.
  private normalizeLabels(span: ReadableSpan): ReadableSpan {
    const normalized = {} as Record<string, any>;
    for (const [key, value] of Object.entries(span.attributes)) {
      normalized[key.replace(/\:/g, '/')] = value;
    }
    return {
      ...span,
      spanContext: span.spanContext,
      attributes: normalized,
    };
  }

  private markFailedAction(span: ReadableSpan): ReadableSpan {
    if (
      span.attributes['genkit:state'] === 'error' &&
      (span.attributes['genkit:type'] === 'action' ||
        span.attributes['genkit:type'] === 'flowStep') &&
      span.attributes['genkit:name']
    ) {
      span.attributes['genkit:failedSpan'] = span.attributes['genkit:name'];
    }
    return span;
  }

  private markGenkitFeature(span: ReadableSpan): ReadableSpan {
    if (span.attributes['genkit:isRoot'] && span.attributes['genkit:name']) {
      span.attributes['genkit:feature'] = span.attributes['genkit:name'];
    }
    return span;
  }

  private markGenkitModel(span: ReadableSpan): ReadableSpan {
    if (
      span.attributes['genkit:metadata:subtype'] === 'model' &&
      span.attributes['genkit:name']
    ) {
      span.attributes['genkit:model'] = span.attributes['genkit:name'];
    }
    return span;
  }
}

function getErrorHandler(
  shouldLogFn: (err: Error) => boolean,
  helpText: string
): (err: Error) => void {
  // only log the first time
  let instructionsLogged = false;

  return (err) => {
    // Use the defaultLogger so that logs don't get swallowed by the open
    // telemetry exporter
    const defaultLogger = logger.defaultLogger;
    if (err && shouldLogFn(err)) {
      if (!instructionsLogged) {
        instructionsLogged = true;
        defaultLogger.error(
          `Unable to send telemetry to Google Cloud: ${err.message}\n\n${helpText}\n`
        );
      }
    } else if (err) {
      defaultLogger.error(`Unable to send telemetry to Google Cloud: ${err}`);
    }
  };
}

export function __getMetricExporterForTesting(): InMemoryMetricExporter {
  return metricExporter as InMemoryMetricExporter;
}

export function __getSpanExporterForTesting(): InMemorySpanExporter {
  return spanExporter.getExporter() as InMemorySpanExporter;
}

export function __forceFlushSpansForTesting() {
  spanProcessor.forceFlush();
}
