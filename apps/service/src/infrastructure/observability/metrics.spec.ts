import { InMemoryMetrics, NoopMetrics } from './metrics';

describe('NoopMetrics', () => {
  it('accepts every instrument silently (default for production paths)', () => {
    const metrics = new NoopMetrics();
    expect(() => {
      metrics.counter('saga.create');
      metrics.gauge('reconciler.stale', 4);
      metrics.histogram('hcm.latency_ms', 120);
    }).not.toThrow();
  });
});

describe('InMemoryMetrics', () => {
  let metrics: InMemoryMetrics;

  beforeEach(() => {
    metrics = new InMemoryMetrics();
  });

  it('captures counter samples with default value=1', () => {
    metrics.counter('saga.create');
    metrics.counter('saga.create', 3, { actor: 'emp-1' });
    expect(metrics.counters).toEqual([
      { name: 'saga.create', value: 1, tags: {} },
      { name: 'saga.create', value: 3, tags: { actor: 'emp-1' } },
    ]);
  });

  it('captures gauges and histograms verbatim', () => {
    metrics.gauge('reconciler.stale', 0);
    metrics.gauge('reconciler.stale', 5, { bucket: '4-12h' });
    metrics.histogram('hcm.latency_ms', 47);
    expect(metrics.gauges).toEqual([
      { name: 'reconciler.stale', value: 0, tags: {} },
      { name: 'reconciler.stale', value: 5, tags: { bucket: '4-12h' } },
    ]);
    expect(metrics.histograms).toEqual([{ name: 'hcm.latency_ms', value: 47, tags: {} }]);
  });

  it('reset() clears every sample', () => {
    metrics.counter('x');
    metrics.gauge('y', 1);
    metrics.histogram('z', 1);
    metrics.reset();
    expect(metrics.counters).toHaveLength(0);
    expect(metrics.gauges).toHaveLength(0);
    expect(metrics.histograms).toHaveLength(0);
  });
});
