import React, { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Node,
  Edge,
  MarkerType,
  Handle,
  Position,
  NodeProps,
} from '@xyflow/react';
import {
  Network,
  Info,
  Globe,
  ShieldCheck,
  Waypoints,
  Cpu,
  Layers,
  Server,
  Activity,
  Database,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  GitCommit,
} from 'lucide-react';
import {
  MetricsSummary,
  NodeState,
  ObservationKind,
  RequestRecord,
  SpanNode,
} from '../types/observatory';
import { ObservationBadge } from './ObservationBadge';

export interface ScreenTopologyProps {
  record: RequestRecord | null;
  mockMode: boolean;
  metrics?: MetricsSummary | null;
  onNavigateTab?: (tab: 'playground' | 'timeline' | 'topology' | 'metrics' | 'learning') => void;
}

interface TopologyComponentMeta {
  id: string;
  stepNumber: number;
  title: string;
  shortTitle: string;
  subtitle: string;
  plane: 'data-path' | 'routing-control' | 'observability';
  planeLabel: string;
  roleDescription: string;
  lifecycleRole: string;
  portsAndProtocols: string;
  provenance: string;
  position: { x: number; y: number };
}

export interface TopologyEdgeMeta {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label: string;
  title: string;
  protocol: string;
  plane: 'inference' | 'telemetry';
  summary: string;
  payloadDetails: string;
  failureBehavior: string;
}

interface JourneyStep {
  id: string;
  index: number;
  label: string;
  shortLabel: string;
  description: string;
  nodeIds: string[];
  edgeIds: string[];
  focusNodeId: string;
  status: 'observed' | 'simulated' | 'error' | 'skipped' | 'configured';
  metricHint?: string;
}

export const TOPOLOGY_COMPONENTS: TopologyComponentMeta[] = [
  {
    id: 'browser',
    stepNumber: 1,
    title: '1. Browser UI',
    shortTitle: 'Browser / Playground',
    subtitle: 'OpenAI Client & SSE Consumer',
    plane: 'data-path',
    planeLabel: 'Client',
    roleDescription:
      'Submits OpenAI-compatible chat completion requests and renders live token chunks alongside correlated lifecycle telemetry.',
    lifecycleRole:
      'Initiates the inference journey and measures end-to-end user-perceived response streaming; aborts propagate immediately upstream.',
    portsAndProtocols: 'HTTP/1.1 POST /api/infer/stream + GET /api/requests/{id}/events',
    provenance: 'React 19 + TypeScript + @xyflow/react',
    position: { x: 20, y: 40 },
  },
  {
    id: 'observer-api',
    stepNumber: 2,
    title: '2. Observer API',
    shortTitle: 'Observer API',
    subtitle: 'Telemetry Proxy (:8080)',
    plane: 'data-path',
    planeLabel: 'Data Path',
    roleDescription:
      'Assigns request_id, starts W3C traceparent span, injects stream_options.include_usage=true, and measures True TTFT vs HTTP header arrival.',
    lifecycleRole:
      'Acts as the transparent measurement boundary between the client and the llm-d Gateway without buffering streamed tokens.',
    portsAndProtocols: 'HTTP :8080 (OpenAI JSON/SSE, /api/metrics, /api/requests)',
    provenance: 'backend/observer (Go + OpenTelemetry SDK)',
    position: { x: 350, y: 40 },
  },
  {
    id: 'gateway-proxy',
    stepNumber: 3,
    title: '3. Gateway / Envoy Proxy',
    shortTitle: 'llm-d Gateway / Envoy',
    subtitle: 'Router Proxy (:8081)',
    plane: 'data-path',
    planeLabel: 'Data Path',
    roleDescription:
      'Receives OpenAI HTTP traffic, strips untrusted x-gateway-destination-endpoint headers, consults EPP over gRPC ext_proc, and routes directly to the chosen vLLM pod.',
    lifecycleRole:
      'Enforces header security, executes ORIGINAL_DST pod routing, and echoes x-gateway-destination-endpoint in response headers for verification.',
    portsAndProtocols: 'HTTP :80 -> :8081, Admin :19001, gRPC ext_proc -> 127.0.0.1:9002',
    provenance: 'docker.io/envoyproxy/envoy:distroless-v1.33.2',
    position: { x: 680, y: 40 },
  },
  {
    id: 'epp',
    stepNumber: 4,
    title: '4. Endpoint Picker (EPP)',
    shortTitle: 'Endpoint Picker (EPP)',
    subtitle: 'gRPC ext_proc (:9002)',
    plane: 'routing-control',
    planeLabel: 'Routing & Admission',
    roleDescription:
      'Executes flow-control priority admission, vLLM render tokenization, 64-token ZMQ prefix-cache affinity filtering (calibrated to 350 tok/s on CPU), and token-load scoring.',
    lifecycleRole:
      'Selects the optimal ready vLLM pod for each request and writes the winning pod IP:port into x-gateway-destination-endpoint.',
    portsAndProtocols: 'gRPC :9002 (ext_proc), gRPC :9003 (health), HTTPS :9090 (/metrics RBAC)',
    provenance: 'ghcr.io/llm-d/llm-d-router-endpoint-picker:v1.0.0',
    position: { x: 680, y: 240 },
  },
  {
    id: 'inference-pool',
    stepNumber: 5,
    title: '5. InferencePool',
    shortTitle: 'InferencePool',
    subtitle: 'inference.networking.k8s.io/v1',
    plane: 'routing-control',
    planeLabel: 'Pool Membership',
    roleDescription:
      'Defines model-server pod membership (llm-d.ai/guide: optimized-baseline), target port 8000, and FailOpen fallback behavior.',
    lifecycleRole:
      'Tracks ready model-server endpoints via Kubernetes informers in the control plane (the K8s API server is never in the request data path).',
    portsAndProtocols: 'CRD inference.networking.k8s.io/v1 + InferenceObjective llm-d.ai/v1',
    provenance: 'GAIE v1.6.2 + llm-d v1.0.0 CRDs',
    position: { x: 1010, y: 240 },
  },
  {
    id: 'model-server',
    stepNumber: 6,
    title: '6. vLLM CPU Model Server',
    shortTitle: 'vLLM CPU Server',
    subtitle: 'Qwen2.5-0.5B-Instruct (:8000)',
    plane: 'data-path',
    planeLabel: 'Inference Engine',
    roleDescription:
      'Executes prompt prefill and autoregressive token decode on 4th Gen Intel Xeon Sapphire Rapids (c3-standard-22) with AMX BF16 and 64-token prefix caching.',
    lifecycleRole:
      'Computes KV-cache prefill, streams SSE token deltas back through Envoy and Observer API, and publishes live KV block events to EPP over ZMQ (:5556).',
    portsAndProtocols: 'HTTP :8000 (/v1/chat/completions, /metrics), ZMQ :5556/:5559 (KV events)',
    provenance: 'docker.io/vllm/vllm-openai-cpu:v0.17.1 (2 replicas)',
    position: { x: 1340, y: 40 },
  },
  {
    id: 'otel-collector',
    stepNumber: 7,
    title: '7. OTel Collector & Jaeger',
    shortTitle: 'OTel Collector → Jaeger',
    subtitle: 'Async Trace Pipeline (:4317 / :16686)',
    plane: 'observability',
    planeLabel: 'Observability Plane',
    roleDescription:
      'Receives OTLP spans asynchronously from Observer API and EPP, scrubs sensitive attributes, and indexes distributed traces in Jaeger.',
    lifecycleRole:
      'Enriches completed requests with internal EPP scheduling spans (tokenize, index_walk, filter_prefix_cache_affinity, pick_endpoints) without slowing token delivery.',
    portsAndProtocols: 'OTLP gRPC :4317, HTTP :4318, Jaeger Query :16686',
    provenance: 'otel/opentelemetry-collector-contrib:0.114.0 + jaeger:1.62.0',
    position: { x: 350, y: 430 },
  },
  {
    id: 'prometheus',
    stepNumber: 8,
    title: '8. Prometheus / GMP',
    shortTitle: 'Prometheus Scraper',
    subtitle: 'Aggregate Metrics (:9090 & :8000)',
    plane: 'observability',
    planeLabel: 'Observability Plane',
    roleDescription:
      'Scrapes system-wide counters and gauges from EPP (:9090 with Bearer token RBAC) and vLLM (:8000/metrics).',
    lifecycleRole:
      'Provides pool-wide saturation, queue depth, KV block hit totals, and request counter reconciliation—strictly separated from single-request latency.',
    portsAndProtocols: 'HTTPS :9090 (EPP RBAC) & HTTP :8000 (vLLM)',
    provenance: 'Google Cloud Managed Service for Prometheus / prom/prometheus:v2.55.1',
    position: { x: 1010, y: 430 },
  },
];

export const TOPOLOGY_EDGES: TopologyEdgeMeta[] = [
  {
    id: 'e-browser-observer',
    source: 'browser',
    target: 'observer-api',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: 'POST /api/infer + SSE',
    title: 'Browser → Observer API',
    protocol: 'HTTP/1.1 POST + Server-Sent Events (SSE)',
    plane: 'inference',
    summary:
      'Submits the OpenAI chat completion request and streams back token deltas in real time while correlating X-Request-Id.',
    payloadDetails:
      'Request JSON (model, prompt, max_tokens, stream, router_mode, priority_band); Response headers include X-Request-Id and X-Trace-Id.',
    failureBehavior:
      'Client abort cancels the fetch stream and immediately triggers context cancellation in the Observer API.',
  },
  {
    id: 'e-observer-gateway',
    source: 'observer-api',
    target: 'gateway-proxy',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: 'OpenAI + traceparent',
    title: 'Observer API → llm-d Gateway / Envoy',
    protocol: 'HTTP/1.1 (:80 → :8081) with W3C Trace Context',
    plane: 'inference',
    summary:
      'Forwards the validated OpenAI payload with W3C traceparent, x-llm-d-inference-objective, and stream_options.include_usage=true.',
    payloadDetails:
      'Propagates traceparent so Observer API and EPP spans share a single distributed trace_id in Jaeger.',
    failureBehavior:
      'Propagates upstream HTTP 429 (saturation shedding) or HTTP 503 (no ready endpoints) back to the Observer API.',
  },
  {
    id: 'e-gateway-epp',
    source: 'gateway-proxy',
    target: 'epp',
    sourceHandle: 'bottom',
    targetHandle: 'top',
    label: 'gRPC ext_proc :9002',
    title: 'Envoy Proxy ↔ Endpoint Picker (EPP)',
    protocol: 'Bidirectional gRPC External Processor (127.0.0.1:9002)',
    plane: 'inference',
    summary:
      'Envoy pauses request routing and streams headers + body to EPP over localhost gRPC ext_proc to compute the optimal target pod.',
    payloadDetails:
      'Envoy strips any client-supplied x-gateway-destination-endpoint first; EPP returns the selected pod IP:port in x-gateway-destination-endpoint.',
    failureBehavior:
      'Configured with failureMode: FailOpen on InferencePool—if EPP is unreachable, Envoy falls back to headless STRICT_DNS load balancing.',
  },
  {
    id: 'e-epp-pool',
    source: 'epp',
    target: 'inference-pool',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: 'Filter & Score',
    title: 'EPP → InferencePool Readiness & Scoring',
    protocol: 'In-Memory Endpoint Index + ZMQ KV Block Index',
    plane: 'inference',
    summary:
      'EPP filters ready pods in the InferencePool using 64-token prefix-cache affinity and scores candidates by active token load.',
    payloadDetails:
      'Combines /v1/chat/completions/render tokenization with ZMQ KV events (:5556) to identify pods holding matching 64-token prefix blocks.',
    failureBehavior:
      'If 0 endpoints are ready, EPP returns HTTP 503 ServiceUnavailable (counted as a pre-routing rejection, not a routed request).',
  },
  {
    id: 'e-pool-model',
    source: 'inference-pool',
    target: 'model-server',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: 'x-gateway-destination-endpoint',
    title: 'InferencePool → Selected vLLM Pod',
    protocol: 'ORIGINAL_DST Pod IP:8000 Selection',
    plane: 'inference',
    summary:
      'Routes the request to the specific winning vLLM pod IP:port selected by EPP and echoes x-gateway-destination-endpoint in the HTTP response.',
    payloadDetails:
      'Observer API resolves the returned <pod_ip>:8000 header against Kubernetes Pod metadata to display the exact winning pod name.',
    failureBehavior:
      'Never inferred from candidate rankings (top_endpoints); only marked observed when x-gateway-destination-endpoint or server.address is present.',
  },
  {
    id: 'e-gateway-model',
    source: 'gateway-proxy',
    target: 'model-server',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: 'SSE Token Stream :8000',
    title: 'Envoy Proxy ↔ vLLM CPU Model Server (SSE Stream)',
    protocol: 'HTTP/1.1 Chunked SSE (:8000/v1/chat/completions)',
    plane: 'inference',
    summary:
      'Streams generated token chunks from the selected vLLM CPU pod back through Envoy and Observer API to the browser.',
    payloadDetails:
      'Emits data: {"choices":[{"delta":{"content":"..."}}]} chunks followed by a final usage chunk (prompt_tokens, completion_tokens) and data: [DONE].',
    failureBehavior:
      'If the model name is unknown or upstream errors occur after routing, vLLM returns HTTP 4xx/5xx (counted in both EPP routed and upstream error counters).',
  },
  {
    id: 'e-observer-otel',
    source: 'observer-api',
    target: 'otel-collector',
    sourceHandle: 'bottom',
    targetHandle: 'top',
    label: 'OTLP :4317',
    title: 'Observer API → OpenTelemetry Collector',
    protocol: 'OTLP gRPC (:4317)',
    plane: 'telemetry',
    summary:
      'Exports the root observer.infer span out-of-band with gen_ai.usage.input_tokens, gen_ai.usage.output_tokens, and llm_d.selected_endpoint.',
    payloadDetails:
      'Sensitive prompt text and credentials are scrubbed prior to span export.',
    failureBehavior:
      'Asynchronous batch export; telemetry collector outages never block inference requests.',
  },
  {
    id: 'e-epp-otel',
    source: 'epp',
    target: 'otel-collector',
    sourceHandle: 'bottom',
    targetHandle: 'top',
    label: 'OTLP Spans',
    title: 'Endpoint Picker (EPP) → OpenTelemetry Collector',
    protocol: 'OTLP gRPC (:4317)',
    plane: 'telemetry',
    summary:
      'Exports internal EPP scheduling spans: tokenize, tokenize_render, index_walk, match_block_keys, filter_prefix_cache_affinity, scoring, and pick_endpoints.',
    payloadDetails:
      'Reveals exact EPP token count (llm_d.epp.token_producer.token_count), KV block hits, sticky routing decisions, and candidate scores.',
    failureBehavior:
      'Flushed asynchronously; Observer API polls Jaeger briefly after stream completion to enrich the request record.',
  },
  {
    id: 'e-epp-prom',
    source: 'epp',
    target: 'prometheus',
    sourceHandle: 'bottom',
    targetHandle: 'top',
    label: '/metrics :9090',
    title: 'Endpoint Picker (EPP) → Prometheus Scraper',
    protocol: 'HTTPS /metrics (:9090 with Kubernetes Bearer Token RBAC)',
    plane: 'telemetry',
    summary:
      'Exposes aggregate pool readiness, routed request totals, flow-control queue size, effective pool saturation, and KV-cache block lookup hits.',
    payloadDetails:
      'Requires ClusterRole llm-d-observatory-metrics-reader (/metrics nonResourceURL) and TokenReview delegation.',
    failureBehavior:
      'Distinguishes genuine 0 counter/gauge values (Aggregate) from scrape failures or disabled subsystems (Unavailable).',
  },
  {
    id: 'e-model-prom',
    source: 'model-server',
    target: 'prometheus',
    sourceHandle: 'bottom',
    targetHandle: 'top',
    label: '/metrics :8000',
    title: 'vLLM CPU Model Server → Prometheus Scraper',
    protocol: 'HTTP /metrics (:8000)',
    plane: 'telemetry',
    summary:
      'Exposes vLLM scheduler running/waiting queue gauges and prefix-cache hit/query counters across all CPU replicas.',
    payloadDetails:
      'Scraped across headless service endpoints (vllm:num_requests_running, vllm:num_requests_waiting, vllm:prefix_cache_hits_total).',
    failureBehavior:
      'System-wide aggregate scope; never conflated with single-request queue wait duration.',
  },
];

interface CustomNodeData extends Record<string, unknown> {
  comp: TopologyComponentMeta;
  status: string;
  statusBadge: string;
  liveDescriptor: string;
  isSelected: boolean;
  isActiveStep: boolean;
  isDimmed: boolean;
  mockMode: boolean;
}

const NODE_ICONS: Record<string, React.ReactNode> = {
  browser: <Globe className="w-4 h-4" aria-hidden="true" />,
  'observer-api': <ShieldCheck className="w-4 h-4" aria-hidden="true" />,
  'gateway-proxy': <Waypoints className="w-4 h-4" aria-hidden="true" />,
  epp: <Cpu className="w-4 h-4" aria-hidden="true" />,
  'inference-pool': <Layers className="w-4 h-4" aria-hidden="true" />,
  'model-server': <Server className="w-4 h-4" aria-hidden="true" />,
  'otel-collector': <Activity className="w-4 h-4" aria-hidden="true" />,
  prometheus: <Database className="w-4 h-4" aria-hidden="true" />,
};

const TopologyCanvasNode: React.FC<NodeProps<Node<CustomNodeData>>> = ({ data }) => {
  const { comp, status, statusBadge, liveDescriptor, isSelected, isActiveStep, isDimmed, mockMode } =
    data;

  let borderClass = 'border-slate-700/90 bg-slate-900/95 text-slate-100';
  let pillClass = 'bg-slate-800 text-slate-300 border-slate-700';
  let iconClass = 'bg-slate-800 text-sky-400';

  if (status === 'observed') {
    if (mockMode) {
      borderClass = 'border-amber-500/80 bg-slate-900/95 text-slate-50';
      pillClass = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      iconClass = 'bg-amber-500/20 text-amber-300';
    } else {
      borderClass = 'border-emerald-500/80 bg-slate-900/95 text-slate-50';
      pillClass = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      iconClass = 'bg-emerald-500/20 text-emerald-300';
    }
  } else if (status === 'error') {
    borderClass = 'border-rose-500/90 bg-rose-950/80 text-slate-50';
    pillClass = 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    iconClass = 'bg-rose-500/20 text-rose-300';
  } else if (status === 'skipped') {
    borderClass = 'border-orange-500/80 bg-slate-900/90 text-slate-200';
    pillClass = 'bg-orange-500/20 text-orange-300 border-orange-500/40';
    iconClass = 'bg-orange-500/20 text-orange-300';
  } else if (comp.plane === 'observability') {
    borderClass = 'border-indigo-500/40 bg-slate-900/90 text-slate-200';
    pillClass = 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
    iconClass = 'bg-indigo-500/15 text-indigo-300';
  }

  const ringClass = isActiveStep
    ? 'ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-950 topology-active-pulse'
    : isSelected
      ? 'ring-2 ring-sky-400/90 ring-offset-1 ring-offset-slate-950'
      : '';

  return (
    <div
      data-testid={`topology-node-${comp.id}`}
      className={`w-[205px] rounded-xl border-2 px-3 py-2.5 shadow-md transition-opacity ${borderClass} ${ringClass} ${
        isDimmed ? 'opacity-45' : 'opacity-100'
      }`}
    >
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-500 !border-slate-900"
      />
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        className="!w-2 !h-2 !bg-slate-500 !border-slate-900"
      />

      <div className="flex items-center justify-between gap-1.5 mb-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
          {comp.planeLabel}
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-1.5 py-0.2 text-[10px] font-medium ${pillClass}`}
        >
          {statusBadge}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div
          className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${iconClass}`}
        >
          {NODE_ICONS[comp.id] || <Network className="w-4 h-4" aria-hidden="true" />}
        </div>
        <div
          className="min-w-0 flex-1"
          title={`${comp.title} — ${liveDescriptor}`}
        >
          <div className="text-xs font-bold leading-tight truncate">{comp.title}</div>
          <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
            {liveDescriptor}
          </div>
        </div>
      </div>

      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="!w-2 !h-2 !bg-slate-500 !border-slate-900"
      />
      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-slate-500 !border-slate-900"
      />
    </div>
  );
};

const nodeTypes = {
  observatoryNode: TopologyCanvasNode,
};

function formatPodShortName(endpoint?: string): string {
  if (!endpoint) return 'Qwen2.5-0.5B (:8000)';
  // e.g. "llm-d-observatory/experimental-small-vllm-decode-6c9bdb656c-sfm46 (10.20.1.15:8000)"
  const slashIdx = endpoint.indexOf('/');
  const clean = slashIdx >= 0 ? endpoint.slice(slashIdx + 1) : endpoint;
  if (clean.length <= 28) return clean;
  const ipMatch = clean.match(/\(([^)]+)\)/);
  const namePart = clean.split(' ')[0];
  const suffix = namePart.slice(-5);
  return ipMatch ? `vllm-...-${suffix} (${ipMatch[1]})` : `vllm-...-${suffix}`;
}

export const ScreenTopology: React.FC<ScreenTopologyProps> = ({
  record,
  mockMode,
  metrics,
  onNavigateTab,
}) => {
  const [inspectorMode, setInspectorMode] = useState<'node' | 'edge'>('node');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('epp');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>('e-gateway-epp');
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const stateByNode = useMemo(() => {
    const map: Record<string, NodeState> = {};
    if (record?.topology) {
      for (const n of record.topology) {
        map[n.node_id] = n;
      }
    }
    return map;
  }, [record]);

  // Build ordered journey steps grounded in actual request events & topology state
  const journeySteps: JourneyStep[] = useMemo(() => {
    const hasEvent = (t: string) => record?.events?.some((e) => e.event_type === t) ?? false;
    const nodeStatus = (id: string): JourneyStep['status'] => {
      const s = stateByNode[id]?.status;
      if (s === 'observed') return mockMode ? 'simulated' : 'observed';
      if (s === 'error') return 'error';
      if (s === 'skipped') return 'skipped';
      return 'configured';
    };

    const headersMs =
      record?.timings?.upstream_headers_ms?.value !== null &&
      record?.timings?.upstream_headers_ms?.value !== undefined
        ? `${record.timings.upstream_headers_ms.value} ms`
        : undefined;
    const ttftMs =
      record?.timings?.ttft_ms?.value !== null && record?.timings?.ttft_ms?.value !== undefined
        ? `TTFT ${record.timings.ttft_ms.value} ms`
        : undefined;
    const e2eMs =
      record?.timings?.total_duration_ms?.value !== null &&
      record?.timings?.total_duration_ms?.value !== undefined
        ? `${record.timings.total_duration_ms.value} ms`
        : undefined;
    const eppTok =
      record?.timings?.epp_token_count !== undefined
        ? `${record.timings.epp_token_count} tok (${record.timings.epp_token_backend || 'epp'})`
        : undefined;

    return [
      {
        id: 'submit',
        index: 0,
        label: '1. Prompt Submitted',
        shortLabel: '1. Submit',
        description:
          'Browser sends OpenAI chat completion request; Observer API assigns request_id and starts W3C traceparent.',
        nodeIds: ['browser', 'observer-api'],
        edgeIds: ['e-browser-observer'],
        focusNodeId: 'observer-api',
        status: nodeStatus('observer-api'),
        metricHint: record ? record.request_id : 'POST /api/infer',
      },
      {
        id: 'gateway',
        index: 1,
        label: '2. Gateway Forwarded',
        shortLabel: '2. Gateway',
        description:
          'Observer API forwards request to Envoy (:8081), which strips untrusted routing headers and invokes EPP ext_proc (:9002).',
        nodeIds: ['observer-api', 'gateway-proxy'],
        edgeIds: ['e-observer-gateway'],
        focusNodeId: 'gateway-proxy',
        status: nodeStatus('gateway-proxy'),
        metricHint: headersMs ? `Headers ${headersMs}` : 'Envoy :8081',
      },
      {
        id: 'epp-route',
        index: 2,
        label: '3. EPP Filter & Score',
        shortLabel: '3. EPP Score',
        description:
          'EPP checks priority-band admission, tokenizes prompt via vLLM render, matches 64-token KV prefix blocks, and scores candidate pods.',
        nodeIds: ['gateway-proxy', 'epp', 'inference-pool'],
        edgeIds: ['e-gateway-epp', 'e-epp-pool'],
        focusNodeId: 'epp',
        status: nodeStatus('epp'),
        metricHint: eppTok || 'ext_proc :9002',
      },
      {
        id: 'endpoint-select',
        index: 3,
        label: '4. Endpoint Selected',
        shortLabel: '4. Pod Picked',
        description:
          'EPP sets x-gateway-destination-endpoint to the winning vLLM pod IP:8000; Envoy routes directly via ORIGINAL_DST.',
        nodeIds: ['epp', 'inference-pool', 'model-server'],
        edgeIds: ['e-pool-model'],
        focusNodeId: 'inference-pool',
        status:
          record?.selected_endpoint || hasEvent('endpoint.selected')
            ? mockMode
              ? 'simulated'
              : 'observed'
            : nodeStatus('inference-pool'),
        metricHint: record?.selected_endpoint
          ? formatPodShortName(record.selected_endpoint)
          : 'x-gateway-destination-endpoint',
      },
      {
        id: 'prefill-ttft',
        index: 4,
        label: '5. Prefill & First Token',
        shortLabel: '5. True TTFT',
        description:
          'Selected vLLM CPU server executes prompt prefill and emits the first non-empty token delta (True TTFT measured at Observer API).',
        nodeIds: ['model-server', 'gateway-proxy', 'observer-api'],
        edgeIds: ['e-gateway-model'],
        focusNodeId: 'model-server',
        status: hasEvent('model.first_token')
          ? mockMode
            ? 'simulated'
            : 'observed'
          : nodeStatus('model-server'),
        metricHint: ttftMs || 'vLLM :8000',
      },
      {
        id: 'stream-decode',
        index: 5,
        label: '6. Streaming Decode',
        shortLabel: '6. Decode SSE',
        description:
          'vLLM streams autoregressive token deltas over SSE back to the browser and emits final exact token usage counts.',
        nodeIds: ['model-server', 'gateway-proxy', 'observer-api', 'browser'],
        edgeIds: ['e-gateway-model', 'e-observer-gateway', 'e-browser-observer'],
        focusNodeId: 'browser',
        status:
          record?.status === 'failed'
            ? 'error'
            : record?.status === 'completed'
              ? mockMode
                ? 'simulated'
                : 'observed'
              : nodeStatus('model-server'),
        metricHint: e2eMs ? `E2E ${e2eMs}` : 'SSE [DONE]',
      },
      {
        id: 'telemetry',
        index: 6,
        label: '7. Async Trace & Metrics',
        shortLabel: '7. Telemetry',
        description:
          'Out-of-band OTLP spans flush to Collector/Jaeger and Prometheus scrapes aggregate gauges without blocking inference traffic.',
        nodeIds: ['observer-api', 'epp', 'otel-collector', 'prometheus', 'model-server'],
        edgeIds: ['e-observer-otel', 'e-epp-otel', 'e-epp-prom', 'e-model-prom'],
        focusNodeId: 'otel-collector',
        status:
          record && record.trace.spans.length > 0
            ? mockMode
              ? 'simulated'
              : 'observed'
            : nodeStatus('otel-collector'),
        metricHint: record ? `${record.trace.spans.length} spans` : 'OTLP & /metrics',
      },
    ];
  }, [record, stateByNode, mockMode]);

  // Step playback timer
  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setActiveStepIndex((prev) => {
        const next = prev === null ? 0 : prev + 1;
        if (next >= journeySteps.length) {
          setIsPlaying(false);
          return null;
        }
        const step = journeySteps[next];
        if (step) {
          setInspectorMode('node');
          setSelectedNodeId(step.focusNodeId);
        }
        return next;
      });
    }, 1400);
    return () => window.clearInterval(timer);
  }, [isPlaying, journeySteps]);

  const activeStep = activeStepIndex !== null ? journeySteps[activeStepIndex] : null;

  const handleSelectStep = (idx: number) => {
    setIsPlaying(false);
    if (activeStepIndex === idx) {
      setActiveStepIndex(null);
      return;
    }
    setActiveStepIndex(idx);
    const step = journeySteps[idx];
    if (step) {
      setInspectorMode('node');
      setSelectedNodeId(step.focusNodeId);
    }
  };

  const handlePlayToggle = () => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      const startIdx =
        activeStepIndex === null || activeStepIndex >= journeySteps.length - 1
          ? 0
          : activeStepIndex;
      setActiveStepIndex(startIdx);
      setInspectorMode('node');
      setSelectedNodeId(journeySteps[startIdx].focusNodeId);
      setIsPlaying(true);
    }
  };

  const handleStepPrev = () => {
    setIsPlaying(false);
    const prevIdx =
      activeStepIndex === null ? journeySteps.length - 1 : Math.max(0, activeStepIndex - 1);
    setActiveStepIndex(prevIdx);
    setInspectorMode('node');
    setSelectedNodeId(journeySteps[prevIdx].focusNodeId);
  };

  const handleStepNext = () => {
    setIsPlaying(false);
    const nextIdx =
      activeStepIndex === null ? 0 : Math.min(journeySteps.length - 1, activeStepIndex + 1);
    setActiveStepIndex(nextIdx);
    setInspectorMode('node');
    setSelectedNodeId(journeySteps[nextIdx].focusNodeId);
  };

  const handleResetWalkthrough = () => {
    setIsPlaying(false);
    setActiveStepIndex(null);
  };

  const nodes: Node<CustomNodeData>[] = useMemo(() => {
    return TOPOLOGY_COMPONENTS.map((comp) => {
      const st = stateByNode[comp.id];
      const status = st?.status || 'configured';

      let statusBadge = 'Configured';
      if (status === 'observed') {
        statusBadge = mockMode ? 'Simulated' : 'Observed';
      } else if (status === 'skipped') {
        statusBadge = 'Skipped';
      } else if (status === 'error') {
        statusBadge = 'Error / Rejected';
      } else if (status === 'unavailable') {
        statusBadge = 'Unavailable';
      }

      // Concise 1-line live descriptor grounded in real data
      let liveDescriptor = comp.subtitle;
      if (record) {
        if (comp.id === 'observer-api' && record.timings.ttft_ms.value !== null) {
          liveDescriptor = `TTFT ${record.timings.ttft_ms.value} ms`;
        } else if (comp.id === 'epp' && record.timings.epp_token_count !== undefined) {
          liveDescriptor = `${record.timings.epp_token_count} tok (${record.timings.epp_token_backend || 'epp'})`;
        } else if (comp.id === 'model-server' && record.selected_endpoint) {
          liveDescriptor = formatPodShortName(record.selected_endpoint);
        } else if (comp.id === 'otel-collector') {
          liveDescriptor = `${record.trace.spans.length} spans (${record.trace.status})`;
        }
      }

      const isActiveStep = activeStep ? activeStep.nodeIds.includes(comp.id) : false;
      const isDimmed = activeStep ? !activeStep.nodeIds.includes(comp.id) : false;

      return {
        id: comp.id,
        type: 'observatoryNode',
        position: comp.position,
        data: {
          comp,
          status,
          statusBadge,
          liveDescriptor,
          isSelected: inspectorMode === 'node' && selectedNodeId === comp.id,
          isActiveStep,
          isDimmed,
          mockMode,
        },
      };
    });
  }, [stateByNode, mockMode, record, activeStep, inspectorMode, selectedNodeId]);

  const edges: Edge[] = useMemo(() => {
    const isObserved = (id: string) => stateByNode[id]?.status === 'observed';
    const activeColor = mockMode ? '#f59e0b' : '#10b981';
    const stepHighlightColor = '#38bdf8';
    const errorColor = '#f43f5e';
    const telemetryColor = '#6366f1';
    const inactiveColor = '#475569';

    return TOPOLOGY_EDGES.map((edgeMeta): Edge => {
      const dashed = edgeMeta.plane === 'telemetry';
      const bothObserved = isObserved(edgeMeta.source) && isObserved(edgeMeta.target);
      const hasError =
        stateByNode[edgeMeta.source]?.status === 'error' ||
        stateByNode[edgeMeta.target]?.status === 'error';
      const inActiveStep = activeStep ? activeStep.edgeIds.includes(edgeMeta.id) : false;
      const isSelectedEdge = inspectorMode === 'edge' && selectedEdgeId === edgeMeta.id;

      let stroke = inactiveColor;
      if (inActiveStep || isSelectedEdge) {
        stroke = stepHighlightColor;
      } else if (hasError) {
        stroke = errorColor;
      } else if (bothObserved) {
        stroke = dashed ? telemetryColor : activeColor;
      }

      const strokeWidth = inActiveStep || isSelectedEdge ? 3 : bothObserved ? 2.25 : 1.5;
      const opacity = activeStep && !inActiveStep ? 0.25 : 1;

      return {
        id: edgeMeta.id,
        source: edgeMeta.source,
        target: edgeMeta.target,
        sourceHandle: edgeMeta.sourceHandle,
        targetHandle: edgeMeta.targetHandle,
        label: edgeMeta.label,
        animated: (inActiveStep || (bothObserved && !dashed)) && !hasError,
        style: {
          stroke,
          strokeWidth,
          strokeDasharray: dashed ? '5 4' : undefined,
          opacity,
          cursor: 'pointer',
        },
        labelStyle: {
          fill: inActiveStep || isSelectedEdge ? '#e0f2fe' : '#94a3b8',
          fontSize: 10,
          fontFamily: 'ui-monospace, monospace',
          fontWeight: inActiveStep || isSelectedEdge ? 700 : 500,
        },
        labelBgStyle: {
          fill: '#090d16',
          fillOpacity: 0.85,
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: stroke,
        },
      };
    });
  }, [stateByNode, mockMode, activeStep, inspectorMode, selectedEdgeId]);

  const selectedMeta =
    TOPOLOGY_COMPONENTS.find((c) => c.id === selectedNodeId) || TOPOLOGY_COMPONENTS[0];
  const selectedState = stateByNode[selectedMeta.id];
  const selectedEdgeMeta =
    TOPOLOGY_EDGES.find((e) => e.id === selectedEdgeId) || TOPOLOGY_EDGES[0];

  // Correlated spans for the selected node
  const nodeSpans: SpanNode[] = useMemo(() => {
    if (!record?.trace?.spans) return [];
    return record.trace.spans.filter((sp) => {
      if (selectedMeta.id === 'epp') {
        return sp.component === 'epp' || sp.service_name.includes('epp');
      }
      if (selectedMeta.id === 'observer-api') {
        return sp.component === 'observer-api' || sp.service_name.includes('observer');
      }
      if (selectedMeta.id === 'model-server') {
        return sp.component === 'model-server' || sp.service_name.includes('vllm');
      }
      if (selectedMeta.id === 'gateway-proxy') {
        return sp.component === 'gateway-proxy' || sp.service_name.includes('envoy');
      }
      if (selectedMeta.id === 'otel-collector') {
        return true;
      }
      return sp.component === selectedMeta.id;
    });
  }, [record, selectedMeta.id]);

  // Component-specific aggregate metrics from MetricsSummary
  const nodeMetrics = useMemo(() => {
    if (!metrics?.series) return [];
    if (selectedMeta.id === 'epp' || selectedMeta.id === 'inference-pool') {
      return metrics.series.filter((s) => s.category === 'epp');
    }
    if (selectedMeta.id === 'model-server') {
      return metrics.series.filter((s) => s.category === 'vllm');
    }
    if (selectedMeta.id === 'observer-api') {
      return metrics.series.filter((s) => s.category === 'observer').slice(0, 6);
    }
    if (selectedMeta.id === 'prometheus') {
      return metrics.series.filter((s) => s.category === 'epp' || s.category === 'vllm').slice(0, 6);
    }
    return [];
  }, [metrics, selectedMeta.id]);

  const defaultObservationKind: ObservationKind = mockMode ? 'simulated' : 'observed';

  return (
    <div className="flex flex-col gap-5">
      {/* Top Request Journey Stepper & Playback Bar */}
      <section
        aria-label="Interactive Inference Journey Controls"
        data-testid="topology-journey-bar"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <Network className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold tracking-tight">
                  Interactive Inference Journey
                </h2>
                <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                  {record
                    ? `Active Request: ${record.request_id}`
                    : 'Static Architecture Walkthrough'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Step through the real request path across data-plane routing, endpoint selection, CPU prefill/decode, and async telemetry.
              </p>
            </div>
          </div>

          {/* Playback Controls */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="topology-play-pause"
              onClick={handlePlayToggle}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  {activeStepIndex !== null ? 'Resume' : 'Trace Journey'}
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="topology-step-prev"
              onClick={handleStepPrev}
              aria-label="Previous lifecycle stage"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 p-1.5 text-xs cursor-pointer"
            >
              <SkipBack className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              data-testid="topology-step-next"
              onClick={handleStepNext}
              aria-label="Next lifecycle stage"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 p-1.5 text-xs cursor-pointer"
            >
              <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              data-testid="topology-reset"
              onClick={handleResetWalkthrough}
              disabled={activeStepIndex === null && !isPlaying}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 px-2.5 py-1.5 text-xs font-medium cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              Full Path
            </button>

            {!record && onNavigateTab && (
              <button
                type="button"
                onClick={() => onNavigateTab('playground')}
                className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300 px-2.5 py-1.5 text-xs font-semibold cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                Send Live Prompt
              </button>
            )}
          </div>
        </div>

        {/* Ordered Stage Stepper Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mt-3">
          {journeySteps.map((step) => {
            const isCurrent = activeStepIndex === step.index;
            let statusDot = 'bg-slate-400';
            if (step.status === 'observed') statusDot = 'bg-emerald-500';
            if (step.status === 'simulated') statusDot = 'bg-amber-500';
            if (step.status === 'error') statusDot = 'bg-rose-500';

            return (
              <button
                key={step.id}
                type="button"
                data-testid={`topology-step-${step.id}`}
                onClick={() => handleSelectStep(step.index)}
                className={`text-left rounded-lg border px-2.5 py-2 transition-all cursor-pointer ${
                  isCurrent
                    ? 'border-sky-500 bg-sky-500/15 ring-1 ring-sky-500'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-semibold truncate">{step.shortLabel}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
                </div>
                <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {step.metricHint}
                </div>
              </button>
            );
          })}
        </div>

        {/* Active Step Narrative Banner when stepping through */}
        {activeStep && (
          <div
            data-testid="topology-active-step-banner"
            className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded-md bg-sky-600 text-white px-2 py-0.5 font-mono text-[11px] font-bold">
                Step {activeStep.index + 1}/7
              </span>
              <strong className="font-semibold">{activeStep.label}:</strong>
              <span className="text-slate-700 dark:text-slate-200">{activeStep.description}</span>
            </div>
            {activeStep.metricHint && (
              <code className="font-mono text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                {activeStep.metricHint}
              </code>
            )}
          </div>
        )}
      </section>

      {/* Main Interactive Graph Canvas + Contextual Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 flex flex-col gap-3">
          {/* Graph Canvas Header & Compact Legend */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden shadow-sm">
            <div className="px-4 py-2.5 border-b border-slate-800/90 bg-slate-900/90 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <span>Observed Path</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span>Simulated Path</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-indigo-400" />
                  <span>Async Telemetry (OTLP / Prom)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-600" />
                  <span>Configured / Static</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span>Rejected / Error</span>
                </div>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Click any node or connection arrow to inspect
              </span>
            </div>

            {/* ReactFlow Canvas */}
            <div data-testid="topology-canvas" className="h-[490px] w-full">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.12 }}
                minZoom={0.45}
                maxZoom={1.6}
                onNodeClick={(_, node) => {
                  setInspectorMode('node');
                  setSelectedNodeId(node.id);
                }}
                onEdgeClick={(_, edge) => {
                  setInspectorMode('edge');
                  setSelectedEdgeId(edge.id);
                }}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#1e293b" gap={22} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>

            {/* Subtle Data Plane vs Control Plane Footnote Bar */}
            <div className="px-4 py-2 border-t border-slate-800/80 bg-slate-900/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>
                <strong className="text-slate-200">Data Plane Separation:</strong> Prompt &amp; token traffic flows directly through{' '}
                <code className="font-mono text-slate-300">Browser → Observer → Envoy ↔ EPP → vLLM</code>. The Kubernetes API server is never in the request path.
              </span>
              {record?.selected_endpoint && (
                <span className="font-mono text-emerald-400">
                  Routed Pod: {formatPodShortName(record.selected_endpoint)}
                </span>
              )}
            </div>
          </div>

          {/* Mobile-Friendly Vertical Flow List (Visible on smaller screens so users don't have to pinch-zoom) */}
          <div
            aria-label="Mobile Architecture Flow List"
            className="md:hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2"
          >
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Compact Component Flow (Tap to Inspect)
            </div>
            {TOPOLOGY_COMPONENTS.map((comp) => {
              const st = stateByNode[comp.id];
              const isSel = inspectorMode === 'node' && selectedNodeId === comp.id;
              return (
                <button
                  key={comp.id}
                  type="button"
                  onClick={() => {
                    setInspectorMode('node');
                    setSelectedNodeId(comp.id);
                  }}
                  className={`w-full text-left rounded-lg border p-2.5 flex items-center justify-between gap-2 text-xs ${
                    isSel
                      ? 'border-sky-500 bg-sky-500/10'
                      : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <div>
                    <div className="font-semibold">{comp.title}</div>
                    <div className="text-[11px] font-mono text-slate-500">{comp.subtitle}</div>
                  </div>
                  <ObservationBadge kind={st?.observation_kind || defaultObservationKind} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Contextual Detail Panel (Node Inspector OR Edge Inspector) */}
        <aside
          aria-label="Topology Component Inspector"
          className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col gap-4 shadow-xs panel-transition"
        >
          {/* Inspector Mode Header */}
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-sky-500" aria-hidden="true" />
              <h3 className="text-sm font-semibold">
                {inspectorMode === 'node' ? 'Component Inspector' : 'Connection Inspector'}
              </h3>
            </div>
            {inspectorMode === 'node' ? (
              <ObservationBadge kind={selectedState?.observation_kind || defaultObservationKind} />
            ) : (
              <span className="rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30 px-2 py-0.5 text-[11px] font-mono">
                {selectedEdgeMeta.plane === 'inference' ? 'Data Path Link' : 'Telemetry Link'}
              </span>
            )}
          </div>

          {inspectorMode === 'node' ? (
            <>
              {/* Node Title & Role */}
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-sky-600 dark:text-sky-400">
                    {selectedMeta.planeLabel}
                  </span>
                </div>
                <div data-testid="inspector-node-title" className="text-base font-bold mt-0.5">
                  {selectedMeta.title}
                </div>
                <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  {selectedMeta.subtitle}
                </div>
              </div>

              <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <p>{selectedMeta.roleDescription}</p>
                <p className="text-slate-500 dark:text-slate-400">{selectedMeta.lifecycleRole}</p>
              </div>

              {/* Live Request Observation Box */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Live Request Status
                  </span>
                  <span className="font-mono text-[11px] font-semibold flex items-center gap-1">
                    {selectedState?.status === 'error' ? (
                      <AlertCircle className="w-3.5 h-3.5 text-rose-500" aria-hidden="true" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                    )}
                    {selectedState?.status || 'configured'}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed">
                  {selectedState?.detail ||
                    'Submit a prompt in the Inference Playground to observe live request traversal across this component.'}
                </div>

                {/* Component-Specific Request Telemetry Highlights */}
                {record && (selectedMeta.id === 'epp' || selectedMeta.id === 'inference-pool' || selectedMeta.id === 'model-server') && (
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1.5 font-mono text-[11px]">
                    <div>
                      <span className="text-slate-500">Selected Pod (x-gateway-destination-endpoint): </span>
                      <strong className="text-emerald-700 dark:text-emerald-300 break-all">
                        {record.selected_endpoint || 'unobserved (never inferred)'}
                      </strong>
                    </div>
                    {record.candidate_endpoints && record.candidate_endpoints.length > 0 && (
                      <div>
                        <span className="text-slate-500">EPP Ranked Candidates: </span>
                        <span className="text-slate-600 dark:text-slate-400 break-all">
                          [{record.candidate_endpoints.join(', ')}]
                        </span>
                      </div>
                    )}
                    {record.timings.epp_token_count !== undefined && (
                      <div>
                        <span className="text-slate-500">EPP Token Producer: </span>
                        <strong>
                          {record.timings.epp_token_count} tokens ({record.timings.epp_token_backend || 'epp'})
                        </strong>
                      </div>
                    )}
                  </div>
                )}

                {record && selectedMeta.id === 'observer-api' && (
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-2 font-mono text-[11px]">
                    <div>
                      <span className="block text-[10px] text-slate-500">HTTP Headers</span>
                      <strong>
                        {record.timings.upstream_headers_ms.value !== null
                          ? `${record.timings.upstream_headers_ms.value} ms`
                          : 'N/A'}
                      </strong>
                    </div>
                    <div>
                      <span className="block text-[10px] text-slate-500">True TTFT</span>
                      <strong>
                        {record.timings.ttft_ms.value !== null
                          ? `${record.timings.ttft_ms.value} ms`
                          : 'N/A'}
                      </strong>
                    </div>
                    <div>
                      <span className="block text-[10px] text-slate-500">Prompt Tokens</span>
                      <strong>
                        {record.timings.prompt_tokens} ({record.timings.prompt_tokens_source || 'estimate'})
                      </strong>
                    </div>
                    <div>
                      <span className="block text-[10px] text-slate-500">Output Tokens</span>
                      <strong>
                        {record.timings.completion_tokens} ({record.timings.completion_tokens_source || 'sse'})
                      </strong>
                    </div>
                  </div>
                )}
              </div>

              {/* Correlated Trace Spans for this Component */}
              {record && nodeSpans.length > 0 && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold flex items-center gap-1.5">
                      <GitCommit className="w-3.5 h-3.5 text-indigo-500" aria-hidden="true" />
                      Correlated Trace Spans ({nodeSpans.length})
                    </span>
                    {onNavigateTab && (
                      <button
                        type="button"
                        onClick={() => onNavigateTab('timeline')}
                        className="text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                      >
                        Full Timeline →
                      </button>
                    )}
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                    {nodeSpans.slice(0, 8).map((sp) => (
                      <div
                        key={sp.span_id}
                        className="flex items-center justify-between gap-2 rounded bg-slate-50 dark:bg-slate-950 px-2 py-1 font-mono text-[11px]"
                      >
                        <span className="truncate text-indigo-700 dark:text-indigo-300">
                          {sp.operation_name}
                        </span>
                        <span className="text-slate-500 shrink-0">
                          {(sp.duration_ns / 1e6).toFixed(2)} ms
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Live Component Metrics Snapshot (if available) */}
              {nodeMetrics.length > 0 && (
                <details className="disclosure-box rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs">
                  <summary className="text-xs font-semibold">
                    Live Component Metrics ({nodeMetrics.length})
                  </summary>
                  <div className="mt-2.5 space-y-1.5 font-mono text-[11px]">
                    {nodeMetrics.map((m) => (
                      <div key={m.name} className="flex items-center justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-400 truncate" title={m.name}>
                          {m.label}
                        </span>
                        <span className="font-bold shrink-0">
                          {m.value !== null ? `${m.value} ${m.unit}` : 'Unavailable'}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Progressive Disclosure for Technical Spec & Image Provenance */}
              <details className="disclosure-box rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs">
                <summary className="text-xs font-semibold">
                  Ports, Protocols &amp; Image Provenance
                </summary>
                <div className="mt-2.5 space-y-2 text-[11px]">
                  <div>
                    <span className="block text-[10px] uppercase tracking-wider text-slate-500">
                      Ports &amp; Protocols
                    </span>
                    <code className="font-mono">{selectedMeta.portsAndProtocols}</code>
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase tracking-wider text-slate-500">
                      Pinned Artifact / CRD
                    </span>
                    <code className="font-mono break-all">{selectedMeta.provenance}</code>
                  </div>
                </div>
              </details>
            </>
          ) : (
            /* Edge / Connection Inspector */
            <>
              <div>
                <div className="text-[11px] font-mono uppercase tracking-wider text-sky-600 dark:text-sky-400">
                  {selectedEdgeMeta.protocol}
                </div>
                <div data-testid="inspector-edge-title" className="text-base font-bold mt-0.5">
                  {selectedEdgeMeta.title}
                </div>
                <div className="text-xs font-mono text-slate-500 mt-0.5">
                  Edge Label: <code>{selectedEdgeMeta.label}</code>
                </div>
              </div>

              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {selectedEdgeMeta.summary}
              </p>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs space-y-2.5">
                <div>
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Headers &amp; Payload Contract
                  </span>
                  <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-relaxed">
                    {selectedEdgeMeta.payloadDetails}
                  </p>
                </div>
                <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Resilience &amp; Failure Behavior
                  </span>
                  <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-relaxed">
                    {selectedEdgeMeta.failureBehavior}
                  </p>
                </div>
              </div>
            </>
          )}

          {/* Quick-Select Component & Connection Pills */}
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
            <div>
              <span className="block text-[11px] font-semibold text-slate-500 mb-1.5">
                Inspect Component Node:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {TOPOLOGY_COMPONENTS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setInspectorMode('node');
                      setSelectedNodeId(c.id);
                    }}
                    className={`rounded-md px-2 py-1 text-[11px] font-mono border transition-colors cursor-pointer ${
                      inspectorMode === 'node' && selectedNodeId === c.id
                        ? 'bg-sky-600 text-white border-sky-600 font-semibold'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {c.id}
                  </button>
                ))}
              </div>
            </div>

            <details className="disclosure-box text-xs">
              <summary className="text-[11px] font-semibold text-slate-500">
                Inspect Connection / Link ({TOPOLOGY_EDGES.length})
              </summary>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {TOPOLOGY_EDGES.map((edge) => (
                  <button
                    key={edge.id}
                    type="button"
                    data-testid={`topology-edge-pill-${edge.id}`}
                    onClick={() => {
                      setInspectorMode('edge');
                      setSelectedEdgeId(edge.id);
                    }}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-mono border transition-colors cursor-pointer ${
                      inspectorMode === 'edge' && selectedEdgeId === edge.id
                        ? 'bg-sky-600 text-white border-sky-600 font-semibold'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span>{edge.source}</span>
                    <ArrowRight className="w-2.5 h-2.5" aria-hidden="true" />
                    <span>{edge.target}</span>
                  </button>
                ))}
              </div>
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
};
