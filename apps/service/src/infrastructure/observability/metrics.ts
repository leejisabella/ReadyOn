import { Injectable } from '@nestjs/common';

/**
 * Minimal three-instrument metrics surface (TRD §18). Counter for monotonic
 * events, gauge for instantaneous state, histogram for distributions.
 *
 * Production deployments bind this to OpenTelemetry / Prometheus / etc. (§19.3
 * out-of-scope); we keep the interface narrow so any binding is a thin
 * adapter rather than a rewrite.
 */
export type MetricTags = Readonly<Record<string, string | number>>;

export interface Metrics {
  counter(name: string, value?: number, tags?: MetricTags): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
  histogram(name: string, value: number, tags?: MetricTags): void;
}

/** Default registration — drops every emission. Cheap and safe. */
@Injectable()
export class NoopMetrics implements Metrics {
  counter(_name: string, _value?: number, _tags?: MetricTags): void {}
  gauge(_name: string, _value: number, _tags?: MetricTags): void {}
  histogram(_name: string, _value: number, _tags?: MetricTags): void {}
}

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly tags: MetricTags;
}

/**
 * In-memory backing for tests. Captures every emission verbatim so assertions
 * can verify call counts, tag shapes, and gauge transitions. Not for prod.
 */
@Injectable()
export class InMemoryMetrics implements Metrics {
  readonly counters: MetricSample[] = [];
  readonly gauges: MetricSample[] = [];
  readonly histograms: MetricSample[] = [];

  counter(name: string, value: number = 1, tags: MetricTags = {}): void {
    this.counters.push({ name, value, tags });
  }
  gauge(name: string, value: number, tags: MetricTags = {}): void {
    this.gauges.push({ name, value, tags });
  }
  histogram(name: string, value: number, tags: MetricTags = {}): void {
    this.histograms.push({ name, value, tags });
  }

  reset(): void {
    this.counters.length = 0;
    this.gauges.length = 0;
    this.histograms.length = 0;
  }
}

/** DI token under which the active `Metrics` implementation is registered. */
export const METRICS = 'METRICS';
