import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ObservationBadge } from '../components/ObservationBadge';
import { ScreenTimeline, sortLifecycleEvents } from '../components/ScreenTimeline';
import { ScreenMetrics } from '../components/ScreenMetrics';
import { ScreenLearningLab } from '../components/ScreenLearningLab';
import { EventEnvelope, MetricsSummary, RequestRecord } from '../types/observatory';

describe('ObservationBadge & Classification Semantics', () => {
  it('renders distinct badges for observed, measured, aggregate, derived, unavailable, and simulated', () => {
    const kinds = ['observed', 'measured', 'aggregate', 'derived', 'unavailable', 'simulated'] as const;
    for (const k of kinds) {
      const { unmount } = render(<ObservationBadge kind={k} />);
      expect(screen.getByTestId(`observation-badge-${k}`)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('ScreenTimeline & Out-of-Order Event Sorting', () => {
  it('sorts out-of-order network events deterministically by sequence and preserves unavailable prefill duration', () => {
    const unordered: EventEnvelope[] = [
      {
        schema_version: '1',
        request_id: 'req_test_1',
        trace_id: 'trace_123',
        event_id: 'evt_3',
        sequence: 3,
        event_type: 'model.first_token',
        source: 'observer-api',
        source_timestamp: '2026-10-26T19:00:00.050Z',
        observation_kind: 'measured',
        component: 'model-server',
        message: 'First non-empty token arrived',
        duration_ns: 50000000,
        attributes: { ttft_ms: 50 },
      },
      {
        schema_version: '1',
        request_id: 'req_test_1',
        trace_id: 'trace_123',
        event_id: 'evt_1',
        sequence: 1,
        event_type: 'request.accepted',
        source: 'observer-api',
        source_timestamp: '2026-10-26T19:00:00.000Z',
        observation_kind: 'observed',
        component: 'observer-api',
        message: 'Accepted',
        duration_ns: 0,
        attributes: {},
      },
      {
        schema_version: '1',
        request_id: 'req_test_1',
        trace_id: 'trace_123',
        event_id: 'evt_2',
        sequence: 2,
        event_type: 'gateway.forwarded',
        source: 'observer-api',
        source_timestamp: '2026-10-26T19:00:00.010Z',
        observation_kind: 'observed',
        component: 'gateway-proxy',
        message: 'Forwarded to Envoy',
        duration_ns: 10000000,
        attributes: {},
      },
    ];

    const sorted = sortLifecycleEvents(unordered);
    expect(sorted.map((e) => e.sequence)).toEqual([1, 2, 3]);

    const mockRecord: RequestRecord = {
      request_id: 'req_test_1',
      trace_id: 'trace_123',
      model: 'Qwen/Qwen2.5-0.5B-Instruct',
      router_mode: 'optimized-baseline',
      priority_band: 'standard-traffic',
      stream: true,
      mock_mode: false,
      status: 'completed',
      http_status: 200,
      created_at: '2026-10-26T19:00:00.000Z',
      prompt_metadata: { prompt_chars: 42 },
      timings: {
        request_start_timestamp: '2026-10-26T19:00:00.000Z',
        upstream_headers_ms: {
          value: 18.5,
          unit: 'ms',
          observation_kind: 'measured',
          source: 'observer-api',
          explanation: 'Headers latency',
        },
        ttft_ms: {
          value: 50.0,
          unit: 'ms',
          observation_kind: 'measured',
          source: 'observer-api',
          explanation: 'True TTFT',
        },
        prefill_duration_ms: {
          value: null,
          unit: 'ms',
          observation_kind: 'unavailable',
          source: 'vllm-model-server',
          explanation: 'Never inferred from TTFT alone',
        },
        total_duration_ms: {
          value: 140.0,
          unit: 'ms',
          observation_kind: 'measured',
          source: 'observer-api',
          explanation: 'Total duration',
        },
        mean_itl_ms: {
          value: 22.5,
          unit: 'ms',
          observation_kind: 'derived',
          source: 'observer-api',
          explanation: 'Derived mean ITL',
        },
        p95_itl_ms: {
          value: 26.0,
          unit: 'ms',
          observation_kind: 'derived',
          source: 'observer-api',
          explanation: 'Derived p95 ITL',
        },
        decode_tokens_per_sec: {
          value: 44.4,
          unit: 'tok/s',
          observation_kind: 'derived',
          source: 'observer-api',
          explanation: 'Decode tok/s',
        },
        e2e_tokens_per_sec: {
          value: 35.7,
          unit: 'tok/s',
          observation_kind: 'derived',
          source: 'observer-api',
          explanation: 'E2E tok/s',
        },
        itl_samples_ms: [20, 25],
        prompt_tokens: 12,
        completion_tokens: 5,
      },
      events: unordered,
      trace: {
        request_id: 'req_test_1',
        trace_id: 'trace_123',
        status: 'partial',
        observation_kind: 'observed',
        backend: 'jaeger-otlp',
        error_message: 'Partial trace: model server span not exported',
        spans: [],
      },
      topology: [],
    };

    render(<ScreenTimeline record={mockRecord} />);
    expect(screen.getByTestId('prefill-duration-value')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('trace-warning-banner')).toHaveTextContent('Partial trace');
    expect(screen.getByTestId('timeline-event-request.accepted')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-event-model.first_token')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-selected-endpoint')).toHaveTextContent(
      'Unavailable (never inferred from candidate rankings)',
    );
  });

  it('displays actual selected endpoint and explicit token provenance separately from candidate rankings', () => {
    const recordWithEndpoint: RequestRecord = {
      request_id: 'req_test_2',
      trace_id: 'trace_456',
      model: 'Qwen/Qwen2.5-0.5B-Instruct',
      router_mode: 'optimized-baseline',
      priority_band: 'standard-traffic',
      stream: true,
      mock_mode: false,
      status: 'completed',
      http_status: 200,
      selected_endpoint: 'llm-d-observatory/experimental-small-vllm-decode-hlbrc (10.20.1.14:8000)',
      candidate_endpoints: ['llm-d-observatory/pod-a-rank-0', 'llm-d-observatory/pod-b-rank-0'],
      created_at: '2026-10-26T19:00:00.000Z',
      prompt_metadata: { prompt_chars: 195 },
      timings: {
        request_start_timestamp: '2026-10-26T19:00:00.000Z',
        upstream_headers_ms: { value: 20, unit: 'ms', observation_kind: 'measured', source: 'observer-api', explanation: '' },
        ttft_ms: { value: 55, unit: 'ms', observation_kind: 'measured', source: 'observer-api', explanation: '' },
        prefill_duration_ms: { value: null, unit: 'ms', observation_kind: 'unavailable', source: 'vllm-model-server', explanation: '' },
        total_duration_ms: { value: 150, unit: 'ms', observation_kind: 'measured', source: 'observer-api', explanation: '' },
        mean_itl_ms: { value: 24, unit: 'ms', observation_kind: 'derived', source: 'observer-api', explanation: '' },
        p95_itl_ms: { value: 28, unit: 'ms', observation_kind: 'derived', source: 'observer-api', explanation: '' },
        decode_tokens_per_sec: { value: 41.6, unit: 'tok/s', observation_kind: 'derived', source: 'observer-api', explanation: '' },
        e2e_tokens_per_sec: { value: 33.3, unit: 'tok/s', observation_kind: 'derived', source: 'observer-api', explanation: '' },
        itl_samples_ms: [24],
        prompt_tokens: 96,
        completion_tokens: 32,
        prompt_tokens_source: 'vllm_usage',
        completion_tokens_source: 'vllm_usage',
        epp_token_count: 96,
        epp_token_backend: 'vllm',
      },
      events: [],
      trace: {
        request_id: 'req_test_2',
        trace_id: 'trace_456',
        status: 'enriched',
        observation_kind: 'observed',
        backend: 'jaeger-otlp',
        spans: [],
      },
      topology: [],
    };

    render(<ScreenTimeline record={recordWithEndpoint} />);
    expect(screen.getByTestId('timeline-selected-endpoint')).toHaveTextContent(
      'llm-d-observatory/experimental-small-vllm-decode-hlbrc (10.20.1.14:8000)',
    );
    expect(screen.getByTestId('timeline-token-provenance')).toHaveTextContent('vllm_usage');
  });
});

describe('ScreenMetrics & Aggregate vs Single-Request Separation', () => {
  it('renders aggregate metrics with explicit scope notice', () => {
    const summary: MetricsSummary = {
      collected_at: '2026-10-26T19:00:00Z',
      mock_mode: true,
      observation_scope: 'simulated',
      scope_notice:
        'Aggregate metrics describe system-wide counters and gauges over a scrape window. Never interpret a global queue gauge as an exact per-request queue wait duration.',
      epp_scrape_status: 'simulated',
      vllm_scrape_status: 'simulated',
      series: [
        {
          name: 'llm_d_epp_flow_control_queue_size',
          label: 'EPP Flow-Control Queue Depth',
          category: 'epp',
          value: 0,
          unit: 'requests',
          observation_kind: 'simulated',
          source: 'llm-d-router-epp (:9090/metrics)',
          explanation: 'System-wide gauge of requests buffered in EPP priority-band queues.',
        },
      ],
      recent_ttft_samples_ms: [45.2],
      recent_itl_samples_ms: [14.1],
      recent_tps_samples: [40.2],
    };

    render(<ScreenMetrics metrics={summary} activeRecord={null} onRefresh={() => {}} />);
    expect(screen.getByTestId('aggregate-metrics-notice')).toHaveTextContent(
      'Never interpret a global queue gauge',
    );
    expect(screen.getByTestId('counter-reconciliation-card')).toHaveTextContent(
      'Request Counter Reconciliation',
    );
    expect(screen.getByTestId('metric-card-llm_d_epp_flow_control_queue_size')).toBeInTheDocument();
  });
});

describe('ScreenLearningLab Navigation', () => {
  it('switches between all 13 architecture and telemetry modules', () => {
    render(<ScreenLearningLab />);
    expect(screen.getByTestId('learning-active-title')).toHaveTextContent(
      '1. Gateway API & Envoy Routing Proxy',
    );
    fireEvent.click(screen.getByTestId('learning-topic-prefill'));
    expect(screen.getByTestId('learning-active-title')).toHaveTextContent(
      '7. Prompt Processing (Prefill)',
    );
  });
});
