import React, { useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Node, Edge, MarkerType } from '@xyflow/react';
import { Network, ShieldAlert, Info } from 'lucide-react';
import { NodeState, RequestRecord } from '../types/observatory';
import { ObservationBadge } from './ObservationBadge';

interface ScreenTopologyProps {
  record: RequestRecord | null;
  mockMode: boolean;
}

interface TopologyComponentMeta {
  id: string;
  title: string;
  subtitle: string;
  roleDescription: string;
  portsAndProtocols: string;
  provenance: string;
  position: { x: number; y: number };
}

const TOPOLOGY_COMPONENTS: TopologyComponentMeta[] = [
  {
    id: 'browser',
    title: '1. Browser UI',
    subtitle: 'Client / SSE Consumer',
    roleDescription:
      'Submits OpenAI-compatible chat completion prompts and subscribes to correlated lifecycle events over Server-Sent Events (SSE).',
    portsAndProtocols: 'HTTP/1.1 POST /api/infer/stream + GET /api/requests/{id}/events',
    provenance: 'React 19 + TypeScript + @xyflow/react',
    position: { x: 20, y: 140 },
  },
  {
    id: 'observer-api',
    title: '2. Observer API',
    subtitle: 'Go Telemetry Proxy (:8080)',
    roleDescription:
      'Assigns request_id, starts W3C traceparent span, enforces model/URL allowlists, distinguishes HTTP header arrival from True TTFT, and emits SSE events.',
    portsAndProtocols: 'HTTP :8080 (JSON, SSE, Prometheus /metrics)',
    provenance: 'backend/observer (Go + OpenTelemetry SDK)',
    position: { x: 240, y: 140 },
  },
  {
    id: 'gateway-proxy',
    title: '3. Gateway / Envoy Proxy',
    subtitle: 'llm-d Router Sidecar (:8081)',
    roleDescription:
      'Receives OpenAI HTTP traffic, strips client-supplied x-gateway-destination-endpoint headers, invokes EPP over gRPC ext_proc (:9002), and routes to the chosen pod via ORIGINAL_DST.',
    portsAndProtocols: 'HTTP :80 -> :8081, Admin/Ready :19001, gRPC ext_proc -> 127.0.0.1:9002',
    provenance: 'docker.io/envoyproxy/envoy:distroless-v1.33.2',
    position: { x: 470, y: 140 },
  },
  {
    id: 'epp',
    title: '4. Endpoint Picker (EPP)',
    subtitle: 'gRPC ext_proc (:9002)',
    roleDescription:
      'Executes prefix-cache affinity filtering (calibrated to peakPrefillThroughput: 350 tok/s on CPU), token-load scoring, and flow-control priority-band admission.',
    portsAndProtocols: 'gRPC :9002 (ext_proc), gRPC :9003 (health), HTTP :9090 (/metrics with RBAC)',
    provenance: 'ghcr.io/llm-d/llm-d-router-endpoint-picker:v1.0.0',
    position: { x: 470, y: 310 },
  },
  {
    id: 'inference-pool',
    title: '5. InferencePool',
    subtitle: 'inference.networking.k8s.io/v1',
    roleDescription:
      'Defines endpoint membership selector (llm-d.ai/guide: optimized-baseline), target port 8000, and FailOpen fallback behavior.',
    portsAndProtocols: 'CRD inference.networking.k8s.io/v1 + InferenceObjective llm-d.ai/v1',
    provenance: 'GAIE v1.6.2 + llm-d v1.0.0 CRDs',
    position: { x: 710, y: 225 },
  },
  {
    id: 'model-server',
    title: '6. vLLM CPU Model Server',
    subtitle: 'Qwen2.5-0.5B-Instruct (:8000)',
    roleDescription:
      'Executes prompt prefill and autoregressive token decode on 4th Gen Intel Xeon Sapphire Rapids (c3-standard-22) with AMX BF16 and prefix caching.',
    portsAndProtocols: 'HTTP :8000 (/v1/chat/completions, /metrics), ZMQ :5556/:5559 (KV events)',
    provenance: 'docker.io/vllm/vllm-openai-cpu:v0.31.0 (2 replicas)',
    position: { x: 950, y: 140 },
  },
  {
    id: 'otel-collector',
    title: '7. OTel Collector & Jaeger',
    subtitle: 'Async Trace Pipeline (:4317 / :16686)',
    roleDescription:
      'Receives OTLP spans from Observer API, EPP, and vLLM out-of-band, scrubs sensitive attributes, and stores traces in Jaeger for async UI enrichment.',
    portsAndProtocols: 'OTLP gRPC :4317, HTTP :4318, Jaeger Query :16686',
    provenance: 'otel/opentelemetry-collector-contrib:0.114.0 + jaeger:1.62.0',
    position: { x: 240, y: 330 },
  },
  {
    id: 'prometheus',
    title: '8. Prometheus / GMP',
    subtitle: 'Aggregate Metrics Scraper',
    roleDescription:
      'Scrapes aggregate system gauges and counters from EPP (:9090 with Bearer token) and vLLM (:8000). Never conflated with per-request timings.',
    portsAndProtocols: 'HTTP :9090 (EPP RBAC) & :8000 (vLLM)',
    provenance: 'Google Cloud Managed Service for Prometheus / prom/prometheus:v2.55.1',
    position: { x: 710, y: 360 },
  },
];

export const ScreenTopology: React.FC<ScreenTopologyProps> = ({ record, mockMode }) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string>('epp');

  const stateByNode = useMemo(() => {
    const map: Record<string, NodeState> = {};
    if (record?.topology) {
      for (const n of record.topology) {
        map[n.node_id] = n;
      }
    }
    return map;
  }, [record]);

  const nodes: Node[] = useMemo(() => {
    return TOPOLOGY_COMPONENTS.map((comp) => {
      const st = stateByNode[comp.id];
      const status = st?.status || 'configured';

      let borderColor = '#64748b';
      let bgColor = '#1e293b';
      let statusBadge = 'Configured';

      if (status === 'observed') {
        borderColor = mockMode ? '#f59e0b' : '#10b981';
        bgColor = mockMode ? '#451a03' : '#064e3b';
        statusBadge = mockMode ? 'Simulated Path' : 'Observed Path';
      } else if (status === 'skipped') {
        borderColor = '#f97316';
        bgColor = '#431407';
        statusBadge = 'Skipped';
      } else if (status === 'error') {
        borderColor = '#ef4444';
        bgColor = '#450a0a';
        statusBadge = 'Rejected / Error';
      } else if (status === 'unavailable') {
        borderColor = '#475569';
        bgColor = '#0f172a';
        statusBadge = 'Unobservable';
      }

      return {
        id: comp.id,
        position: comp.position,
        data: {
          label: (
            <div data-testid={`topology-node-${comp.id}`} className="text-left p-1">
              <div className="text-[10px] font-mono uppercase tracking-wider opacity-80">{statusBadge}</div>
              <div className="text-xs font-bold mt-0.5">{comp.title}</div>
              <div className="text-[11px] opacity-85 font-mono">{comp.subtitle}</div>
            </div>
          ),
        },
        style: {
          background: bgColor,
          color: '#f8fafc',
          border: `2px solid ${borderColor}`,
          borderRadius: '10px',
          width: 195,
          fontSize: '12px',
          cursor: 'pointer',
        },
      };
    });
  }, [stateByNode, mockMode]);

  const edges: Edge[] = useMemo(() => {
    const isObserved = (id: string) => stateByNode[id]?.status === 'observed';
    const activeColor = mockMode ? '#f59e0b' : '#10b981';
    const inactiveColor = '#64748b';

    const makeEdge = (id: string, source: string, target: string, label: string, dashed = false): Edge => {
      const active = isObserved(source) && isObserved(target);
      return {
        id,
        source,
        target,
        label,
        animated: active && !dashed,
        style: {
          stroke: active ? activeColor : inactiveColor,
          strokeWidth: active ? 2.5 : 1.5,
          strokeDasharray: dashed ? '5 4' : undefined,
        },
        labelStyle: { fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: active ? activeColor : inactiveColor,
        },
      };
    };

    return [
      makeEdge('e-browser-observer', 'browser', 'observer-api', 'POST /api/infer + SSE'),
      makeEdge('e-observer-gateway', 'observer-api', 'gateway-proxy', 'OpenAI + traceparent'),
      makeEdge('e-gateway-epp', 'gateway-proxy', 'epp', 'gRPC ext_proc :9002'),
      makeEdge('e-epp-pool', 'epp', 'inference-pool', 'Filter & Score'),
      makeEdge('e-pool-model', 'inference-pool', 'model-server', 'x-gateway-destination-endpoint'),
      makeEdge('e-gateway-model', 'gateway-proxy', 'model-server', 'SSE Token Stream :8000'),
      makeEdge('e-observer-otel', 'observer-api', 'otel-collector', 'OTLP :4317', true),
      makeEdge('e-epp-otel', 'epp', 'otel-collector', 'OTLP Spans', true),
      makeEdge('e-epp-prom', 'epp', 'prometheus', '/metrics :9090', true),
      makeEdge('e-model-prom', 'model-server', 'prometheus', '/metrics :8000', true),
    ];
  }, [stateByNode, mockMode]);

  const selectedMeta =
    TOPOLOGY_COMPONENTS.find((c) => c.id === selectedNodeId) || TOPOLOGY_COMPONENTS[0];
  const selectedState = stateByNode[selectedMeta.id];

  return (
    <div className="flex flex-col gap-6">
      {/* Architecture vs Control Plane Callout & Legend */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs">
            <h2 className="font-semibold text-sm">
              Data Path vs. Control Plane Separation (Kubernetes API Server Is NOT in the Inference Data Path)
            </h2>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              Inference requests flow directly through <strong>Browser → Observer API → Envoy Proxy (:8081) ↔ EPP (:9002) → vLLM CPU Model Server (:8000)</strong>.
              The Kubernetes API server only reconciles CRDs (<code className="font-mono">InferencePool</code>,{' '}
              <code className="font-mono">InferenceObjective</code>, <code className="font-mono">Pod</code> watches) in the control plane and never proxies prompt or token traffic.
            </p>
          </div>
        </div>

        <div className="lg:col-span-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-xs">
          <div className="font-semibold mb-2 flex items-center gap-1.5">
            <Network className="w-4 h-4 text-sky-500" aria-hidden="true" />
            Path State Legend
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-xs bg-emerald-600 border border-emerald-400" />
              <span>Observed Request Path</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-xs bg-amber-700 border border-amber-400" />
              <span>Simulated Local Path</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-xs bg-slate-800 border border-slate-500" />
              <span>Configured / Idle</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-xs bg-orange-950 border border-orange-500" />
              <span>Skipped / Rejected</span>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive ReactFlow Canvas + Node Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div
          data-testid="topology-canvas"
          className="lg:col-span-8 h-[480px] rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-950 overflow-hidden"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#334155" gap={20} />
            <Controls />
          </ReactFlow>
        </div>

        {/* Component Technical Inspector */}
        <aside
          aria-label="Topology Component Inspector"
          className="lg:col-span-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 flex flex-col gap-3"
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-sky-500" aria-hidden="true" />
              <h3 className="text-sm font-semibold">Component Inspector</h3>
            </div>
            {selectedState && <ObservationBadge kind={selectedState.observation_kind} />}
          </div>

          <div>
            <div data-testid="inspector-node-title" className="text-base font-bold">
              {selectedMeta.title}
            </div>
            <div className="text-xs font-mono text-sky-600 dark:text-sky-400">{selectedMeta.subtitle}</div>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {selectedMeta.roleDescription}
          </p>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs space-y-2">
            <div>
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">Ports & Protocols</span>
              <code className="font-mono text-[11px]">{selectedMeta.portsAndProtocols}</code>
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">Pinned Artifact / Image</span>
              <code className="font-mono text-[11px] break-all">{selectedMeta.provenance}</code>
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">
                Current Request Observation
              </span>
              <div className="font-mono text-[11px] mt-0.5">
                Status: <strong>{selectedState?.status || 'configured'}</strong> —{' '}
                {selectedState?.detail || 'Click Send Request to observe live path traversal.'}
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <span className="block text-[11px] font-semibold text-slate-500 mb-1.5">
              Quick Select Node:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {TOPOLOGY_COMPONENTS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedNodeId(c.id)}
                  className={`rounded px-2 py-1 text-[11px] font-mono border transition-colors cursor-pointer ${
                    selectedNodeId === c.id
                      ? 'bg-sky-600 text-white border-sky-600'
                      : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {c.id}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
