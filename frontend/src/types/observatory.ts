export type ObservationKind =
  | 'observed'
  | 'measured'
  | 'aggregate'
  | 'derived'
  | 'unavailable'
  | 'simulated';

export type EventType =
  | 'request.accepted'
  | 'gateway.forwarded'
  | 'queue.observed'
  | 'routing.started'
  | 'endpoint.selected'
  | 'model.request.started'
  | 'model.first_token'
  | 'model.token'
  | 'model.stream.completed'
  | 'request.completed'
  | 'request.cancelled'
  | 'request.failed'
  | 'trace.enriched';

export interface EventEnvelope {
  schema_version: string;
  request_id: string;
  trace_id?: string;
  event_id: string;
  sequence: number;
  event_type: EventType;
  source: string;
  source_timestamp: string;
  observation_kind: ObservationKind;
  component: string;
  message: string;
  duration_ns: number | null;
  attributes: Record<string, any>;
}

export interface ClassifiedValue {
  value: number | null;
  unit: string;
  observation_kind: ObservationKind;
  source: string;
  explanation: string;
}

export interface TimingBreakdown {
  request_start_timestamp: string;
  upstream_headers_ms: ClassifiedValue;
  ttft_ms: ClassifiedValue;
  prefill_duration_ms: ClassifiedValue;
  total_duration_ms: ClassifiedValue;
  mean_itl_ms: ClassifiedValue;
  p95_itl_ms: ClassifiedValue;
  decode_tokens_per_sec: ClassifiedValue;
  e2e_tokens_per_sec: ClassifiedValue;
  itl_samples_ms: number[];
  prompt_tokens: number;
  completion_tokens: number;
}

export interface SpanNode {
  span_id: string;
  parent_span_id?: string;
  trace_id: string;
  operation_name: string;
  service_name: string;
  component: string;
  start_time: string;
  end_time: string;
  duration_ns: number;
  observation_kind: ObservationKind;
  status: string;
  attributes: Record<string, any>;
}

export interface TraceRecord {
  request_id: string;
  trace_id: string;
  status: 'pending' | 'enriched' | 'partial' | 'unavailable' | 'timeout' | string;
  observation_kind: ObservationKind;
  backend: string;
  enriched_at?: string;
  error_message?: string;
  spans: SpanNode[];
}

export interface NodeState {
  node_id: string;
  status: 'observed' | 'skipped' | 'unavailable' | 'configured' | 'error' | string;
  observation_kind: ObservationKind;
  detail: string;
}

export interface RequestRecord {
  request_id: string;
  trace_id: string;
  model: string;
  router_mode: string;
  priority_band: string;
  stream: boolean;
  mock_mode: boolean;
  scenario?: string;
  status: 'in_flight' | 'completed' | 'cancelled' | 'failed' | string;
  http_status: number;
  selected_endpoint?: string;
  created_at: string;
  completed_at?: string;
  error_message?: string;
  prompt_metadata: Record<string, any>;
  timings: TimingBreakdown;
  events: EventEnvelope[];
  trace: TraceRecord;
  topology: NodeState[];
}

export interface MetricSeries {
  name: string;
  label: string;
  category: 'observer' | 'epp' | 'vllm' | 'resource' | string;
  value: number | null;
  unit: string;
  observation_kind: ObservationKind;
  source: string;
  explanation: string;
}

export interface MetricsSummary {
  collected_at: string;
  mock_mode: boolean;
  observation_scope: ObservationKind;
  scope_notice: string;
  epp_scrape_status: string;
  vllm_scrape_status: string;
  series: MetricSeries[];
  recent_ttft_samples_ms: number[];
  recent_itl_samples_ms: number[];
  recent_tps_samples: number[];
}

export interface ServerConfig {
  version: string;
  mock_mode: boolean;
  redact_prompts: boolean;
  allowed_models: string[];
  default_model: string;
  router_mode: string;
  max_output_tokens: number;
  cluster_name: string;
  namespace: string;
  upstream_url: string;
  router_modes: string[];
  priority_bands: string[];
  mock_scenarios: string[];
}

export const STAGE_EXPLANATIONS: Record<EventType, string> = {
  'request.accepted':
    'Observer API validates the OpenAI chat completion request, assigns a unique request_id, starts a W3C traceparent span, and redacts raw prompt content from logs.',
  'gateway.forwarded':
    'Observer API forwards the HTTP request to the llm-d Envoy proxy (:8081), which invokes the Endpoint Picker (EPP) over gRPC ext_proc (:9002).',
  'queue.observed':
    'EPP flow-control admission controller evaluates priority-band concurrency limits and queues or sheds requests (HTTP 429 rejected-saturated) under burst load.',
  'routing.started':
    'EPP executes its configured scheduling profile plugins (e.g., prefix-cache-affinity-filter calibrated to 350 tok/s for CPU and token-load-scorer).',
  'endpoint.selected':
    'EPP selects the optimal ready vLLM pod from the InferencePool and writes x-gateway-destination-endpoint for Envoy original_dst routing.',
  'model.request.started':
    'The selected vLLM CPU model server accepts the HTTP request and begins prompt prefill. Note: HTTP 200 headers arrive before the first generated text token.',
  'model.first_token':
    'True Time To First Token (TTFT): the first non-empty choices[0].delta.content token chunk arrives at the Observer API (initial empty role chunk is ignored).',
  'model.token':
    'Autoregressive decode step: a subsequent generated token arrives over the SSE stream and inter-token latency (ITL) is measured.',
  'model.stream.completed':
    'The upstream vLLM SSE stream emits the terminal data: [DONE] sentinel indicating decode generation has finished.',
  'request.completed':
    'Observer API finalizes per-request measured and derived timings (TTFT, Mean/p95 ITL, Decode tok/s) and closes the client response.',
  'request.cancelled':
    'The browser or benchmark client aborted the request in-flight; Observer API cancels its upstream HTTP context so vLLM stops generating tokens.',
  'request.failed':
    'An upstream HTTP 4xx/5xx error, saturation rejection, or timeout terminated the inference request.',
  'trace.enriched':
    'Asynchronous OpenTelemetry trace spans collected via OTLP Collector and Jaeger are correlated with the completed request without delaying token streaming.',
};

export const OBSERVATION_META: Record<
  ObservationKind,
  { label: string; symbol: string; description: string; badgeClass: string }
> = {
  observed: {
    label: 'Observed',
    symbol: '◉',
    description: 'A real backend event, HTTP header, or OpenTelemetry span was directly observed.',
    badgeClass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
  },
  measured: {
    label: 'Measured',
    symbol: '⏱',
    description: 'The Observer API directly measured this timestamp or duration using monotonic clocks.',
    badgeClass: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40',
  },
  aggregate: {
    label: 'Aggregate',
    symbol: '∑',
    description: 'System-wide counter or gauge over a scrape window; never attributed to a single request.',
    badgeClass: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/40',
  },
  derived: {
    label: 'Derived',
    symbol: 'ƒ',
    description: 'Calculated deterministically from measured data (e.g., Mean ITL, p95 ITL, Decode tok/s).',
    badgeClass: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40',
  },
  unavailable: {
    label: 'Unavailable',
    symbol: '⊘',
    description: 'Not exposed by the current stack configuration (e.g., exact prefill duration without a prefill span).',
    badgeClass: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/40',
  },
  simulated: {
    label: 'Simulated',
    symbol: '⚙',
    description: 'Generated by the deterministic local demo simulator (OBSERVER_MOCK_MODE=true), not live GKE.',
    badgeClass: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/50',
  },
};
