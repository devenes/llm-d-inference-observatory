import React, { useState } from 'react';
import { BookOpen, CheckCircle, AlertTriangle, Code2 } from 'lucide-react';

interface LearningTopic {
  id: string;
  title: string;
  category: string;
  summary: string;
  howItWorks: string;
  observabilityBoundary: string;
  configSnippet: string;
}

const LEARNING_TOPICS: LearningTopic[] = [
  {
    id: 'gateway-proxy',
    title: '1. Gateway API & Envoy Routing Proxy',
    category: 'Traffic & Routing',
    summary:
      'Receives OpenAI HTTP traffic on :8081, enforces header security, and delegates endpoint selection to EPP over gRPC ext_proc (:9002).',
    howItWorks:
      'In llm-d v1.0.0 standalone mode, Envoy runs alongside the Endpoint Picker (EPP) in the llm-d-router-epp pod. An early header mutation strips any client-supplied x-gateway-destination-endpoint header so external clients cannot spoof backend pod selection. Envoy then streams request headers and body to EPP via envoy.filters.http.ext_proc on localhost:9002. Crucially, the Kubernetes control-plane API server is NEVER in the inference data path.',
    observabilityBoundary:
      'Observed via W3C traceparent propagation, Envoy HTTP response headers, and Observer API gateway.forwarded timing.',
    configSnippet: `early_header_mutation_extensions:
  - remove: x-gateway-destination-endpoint
http_filters:
  - name: envoy.filters.http.ext_proc
    authority: localhost:9002
    failure_mode_allow: true`,
  },
  {
    id: 'endpoint-picker',
    title: '2. Endpoint Picker (EPP)',
    category: 'Traffic & Routing',
    summary:
      'Stateful gRPC external processor (ghcr.io/llm-d/llm-d-router-endpoint-picker:v1.0.0) that filters and scores ready model-server pods.',
    howItWorks:
      'EPP watches the InferencePool and matching vLLM pods via Kubernetes informers (control plane) and scrapes per-pod metrics or ZMQ KV-cache events. On each request, EPP executes its configured EndpointPickerConfig plugins, selects the best pod IP:port, sets x-gateway-destination-endpoint, and clears Envoy route cache so original_destination_cluster routes directly to that pod.',
    observabilityBoundary:
      'Exposes RBAC-protected Prometheus metrics on :9090/metrics (llm_d_epp_*) and OTLP spans when router.tracing.enabled=true (--tracing=true).',
    configSnippet: `apiVersion: llm-d.ai/v1
kind: EndpointPickerConfig
plugins:
  - type: approx-prefix-cache-producer
  - type: inflight-load-producer
  - type: prefix-cache-affinity-filter
    parameters:
      peakPrefillThroughput: 350
  - type: token-load-scorer`,
  },
  {
    id: 'inference-pool',
    title: '3. InferencePool & Endpoint Membership',
    category: 'Kubernetes CRDs',
    summary:
      'Gateway API Inference Extension v1.6.2 CRD (inference.networking.k8s.io/v1) defining the pool of model server pods and failure mode.',
    howItWorks:
      'InferencePool binds a pod label selector (llm-d.ai/guide: optimized-baseline) and target port (8000) to the EPP gRPC service (:9002). With failureMode: FailOpen, if EPP becomes unreachable, Envoy automatically falls back to the headless STRICT_DNS service (llm-d-router-epp-model-servers:8000) using LEAST_REQUEST load balancing.',
    observabilityBoundary:
      'Pool readiness is tracked via llm_d_epp_ready_endpoints on :9090/metrics.',
    configSnippet: `apiVersion: inference.networking.k8s.io/v1
kind: InferencePool
metadata:
  name: llm-d-router
spec:
  targetPorts: [{ number: 8000 }]
  selector:
    matchLabels:
      llm-d.ai/guide: optimized-baseline
  endpointPickerRef:
    name: llm-d-router-epp
    port: { number: 9002 }
    failureMode: FailOpen`,
  },
  {
    id: 'queueing-backpressure',
    title: '4. Queueing, Flow Control & Backpressure',
    category: 'Admission Control',
    summary:
      'Priority-band admission queues and saturation shedding via InferenceObjective (llm-d.ai/v1) and EPP flowControl feature gate.',
    howItWorks:
      'When featureGates: [flowControl] is active, EPP uses concurrency-detector (maxConcurrency: 2 per CPU replica) to detect pool saturation. Requests carry x-llm-d-inference-objective matching premium-traffic (priority: 100), standard-traffic (priority: 0), or best-effort-traffic (priority: -10). Under burst overload, low-priority requests are buffered or shed with HTTP 429 and header x-llm-d-request-dropped-reason: rejected-saturated.',
    observabilityBoundary:
      'Aggregate queue depth is exposed via llm_d_epp_flow_control_queue_size and llm_d_epp_flow_control_pool_saturation. Never label the global queue gauge as a single request exact wait time.',
    configSnippet: `featureGates: [flowControl]
priorityBands:
  - priority: 100 # premium-traffic
    maxRequests: "50"
  - priority: 0   # standard-traffic
    maxRequests: "30"
  - priority: -10 # best-effort-traffic
    maxRequests: "6"`,
  },
  {
    id: 'filtering-scoring',
    title: '5. Endpoint Filtering & Scoring on CPU',
    category: 'Traffic & Routing',
    summary:
      'Balances prefix-cache locality against in-flight prefill/decode load using CPU-calibrated throughput parameters.',
    howItWorks:
      'Upstream GPU defaults set peakPrefillThroughput to 15,928 tok/s (calibrated for H100 GPUs). On 4th Gen Intel Xeon Sapphire Rapids CPUs (c3-standard-22), single-replica prefill throughput is ~250–500 tok/s. Setting peakPrefillThroughput: 350 allows prefix-cache-affinity-filter and token-load-scorer to spill concurrent bursts across replicas rather than pinning all requests to one saturated CPU pod.',
    observabilityBoundary:
      'Aggregate routing decisions and cache hits appear in llm_d_epp_request_total and vllm:prefix_cache_hits_total.',
    configSnippet: `- type: prefix-cache-affinity-filter
  parameters:
    peakPrefillThroughput: 350 # Calibrated for Intel Sapphire Rapids CPU
- type: token-load-scorer`,
  },
  {
    id: 'model-server-queues',
    title: '6. Model-Server Internal Scheduler Queues',
    category: 'vLLM CPU Engine',
    summary:
      'Once routed to a vLLM pod, requests enter the vLLM continuous-batching scheduler (running vs. waiting queues).',
    howItWorks:
      'Each vLLM replica maintains an internal running batch and waiting queue bounded by --max_model_len=4096 and VLLM_CPU_KVCACHE_SPACE=4 (4 GiB pre-allocated CPU RAM for 64-token KV blocks). If KV blocks or batch slots are full, requests wait inside vLLM.',
    observabilityBoundary:
      'Exposed as aggregate gauges vllm:num_requests_running and vllm:num_requests_waiting on :8000/metrics.',
    configSnippet: `vllm:num_requests_running 2
vllm:num_requests_waiting 0
# Environment: VLLM_CPU_KVCACHE_SPACE="4"`,
  },
  {
    id: 'prefill',
    title: '7. Prompt Processing (Prefill)',
    category: 'vLLM CPU Engine',
    summary:
      'Compute-bound forward pass over all input prompt tokens to populate the KV cache before the first output token is emitted.',
    howItWorks:
      'On Intel Sapphire Rapids (c3-standard-22), vLLM accelerates BF16 matrix multiplications during prefill using hardware Advanced Matrix Extensions (amx_bf16, amx_tile). If --enable-prefix-caching hits existing 64-token blocks, cached prefix blocks are skipped.',
    observabilityBoundary:
      'IMPORTANT: Exact prefill duration is NEVER inferred from TTFT alone, because TTFT also includes network transit, Envoy/EPP routing, queueing, and the first decode step. Without an explicit model-server prefill span, prefill duration is marked unavailable.',
    configSnippet: `vllm serve Qwen/Qwen2.5-0.5B-Instruct \\
  --enable-prefix-caching \\
  --block-size=64 \\
  --max_model_len=4096`,
  },
  {
    id: 'decode',
    title: '8. Autoregressive Token Generation (Decode)',
    category: 'vLLM CPU Engine',
    summary:
      'Memory-bandwidth-bound step-by-step generation of output tokens streamed back to the client via SSE.',
    howItWorks:
      'After prefill emits the first token, each subsequent decode iteration attends over the KV cache in DDR5 memory and appends one token. On experimental-small (2x Qwen2.5-0.5B-Instruct on c3-standard-22), single-stream decode runs at ~40.5 tok/s (~24.6 ms ITL) and scales to ~224.6 tok/s at concurrency 16.',
    observabilityBoundary:
      'Directly measured per token chunk by the Observer API (model.token events) and summarized as Mean ITL, p95 ITL, and Decode tok/s.',
    configSnippet: `data: {"choices":[{"index":0,"delta":{"content":" token"},"finish_reason":null}]}
data: [DONE]`,
  },
  {
    id: 'ttft-and-itl',
    title: '9. True TTFT vs. HTTP Headers & Inter-Token Latency (ITL)',
    category: 'Observability & Timing',
    summary:
      'Distinguishes HTTP 200 header arrival from the first non-empty text token (True TTFT) and measures inter-token intervals.',
    howItWorks:
      'OpenAI-compatible model servers often flush HTTP 200 headers and an initial SSE chunk containing only {"role":"assistant","content":""} before prompt prefill finishes. Counting header arrival or the empty role chunk under-reports TTFT. The Observer API inspects every SSE JSON delta and records model.first_token only when choices[0].delta.content is non-empty.',
    observabilityBoundary:
      'UpstreamHeadersMs and TTFTMs are classified as measured; MeanITLMs, P95ITLMs, and DecodeTokensPerSec are classified as derived.',
    configSnippet: `// Ignore initial empty role chunk:
if chunk.Choices[0].Delta.Content == "" {
    continue // Not True TTFT!
}`,
  },
  {
    id: 'streaming',
    title: '10. Dual-Channel SSE Streaming Architecture',
    category: 'Observability & Timing',
    summary:
      'Separates the OpenAI token stream (POST /api/infer/stream) from the structured lifecycle event channel (GET /api/requests/{id}/events).',
    howItWorks:
      'The Observer API flushes raw OpenAI SSE chunks directly to the caller without buffering while simultaneously publishing typed EventEnvelope objects (schema_version: "1") to an in-memory pub/sub hub consumed by the Live Lifecycle Timeline.',
    observabilityBoundary:
      'Preserves full OpenAI SDK compatibility while providing millisecond-level lifecycle visibility.',
    configSnippet: `POST /api/infer/stream -> X-Request-Id: req_... (OpenAI SSE stream)
GET  /api/requests/{id}/events -> EventEnvelope SSE stream`,
  },
  {
    id: 'prefix-caching',
    title: '11. Approximate vs. Precise Prefix Caching',
    category: 'Traffic & Routing',
    summary:
      'Compares history-based approximate prefix routing against real-time ZMQ KV-cache event indexing.',
    howItWorks:
      'In optimized-baseline mode, approx-prefix-cache-producer estimates cache locality from recent routing history (achieving ~72.6% warm hit rate vs 48.4% L4 round-robin). In precise-prefix-cache mode, vLLM publishes live KV block admissions/evictions over ZMQ PUB (:5556) and replay (:5559) while EPP tokenizes prompts via /v1/*/render using xxh64 64-token block hashes.',
    observabilityBoundary:
      'Tracked via llm_d_epp_kv_cache_index_lookup_hits_total, llm_d_epp_prefix_predicted_cached_tokens_sum, and vllm:prefix_cache_hits_total.',
    configSnippet: `--kv-events-config '{"enable_kv_cache_events":true,"publisher":"zmq",
  "endpoint":"tcp://*:5556","replay_endpoint":"tcp://*:5559"}'`,
  },
  {
    id: 'traces-and-metrics',
    title: '12. OpenTelemetry Trace Spans & Prometheus Metrics',
    category: 'Observability & Timing',
    summary:
      'Explains how distributed trace correlation and asynchronous enrichment work alongside Prometheus scraping.',
    howItWorks:
      'In the reference llm-d-gke-cpu-lab repo, router.tracing.enabled was omitted, rendering --tracing=false. This Observatory enables router.tracing.enabled: true on EPP and --otlp-traces-endpoint on vLLM, exporting spans to otel-collector (:4317) -> Jaeger (:16686). Because spans flush asynchronously in batches, the Observer API enriches the request timeline after token streaming completes (trace.enriched).',
    observabilityBoundary:
      'All raw prompt text and bearer tokens are scrubbed before logging or span export.',
    configSnippet: `router:
  tracing:
    enabled: true
    otelExporterEndpoint: "http://otel-collector:4317"`,
  },
  {
    id: 'errors-and-cancellation',
    title: '13. Error Handling, Cancellation & CPU Cold-Start JIT',
    category: 'Operations & Reliability',
    summary:
      'Covers client cancellation propagation, upstream saturation errors, and the ~85–95s vLLM CPU Torch/OneDNN JIT compilation delay.',
    howItWorks:
      'When a user clicks Cancel, the browser aborts the fetch stream, cancelling the Go Observer API request context and terminating the upstream vLLM connection immediately (request.cancelled). Operationally on GKE CPU, vLLM /v1/models returns 200 OK before first-request Torch/OneDNN C++ kernel compilation (~85–95s); always run a 2-token warmup per pod before benchmarking.',
    observabilityBoundary:
      'Recorded as request.cancelled (HTTP 499) or request.failed (HTTP 429/502/504) with full error context.',
    configSnippet: `# Warm up each ready vLLM CPU pod before latency measurement:
curl -s http://localhost:8000/v1/completions \\
  -d '{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"warmup","max_tokens":2}'`,
  },
];

export const ScreenLearningLab: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string>(LEARNING_TOPICS[0].id);
  const activeTopic = LEARNING_TOPICS.find((t) => t.id === selectedId) || LEARNING_TOPICS[0];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Navigation List */}
      <nav
        aria-label="Learning Lab Topics"
        className="lg:col-span-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex flex-col gap-1.5 max-h-[680px] overflow-y-auto"
      >
        <div className="flex items-center gap-2 px-2 pb-2 mb-1 border-b border-slate-200 dark:border-slate-800">
          <BookOpen className="w-4 h-4 text-sky-500" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Architecture & Telemetry Modules (13)</h2>
        </div>
        {LEARNING_TOPICS.map((topic) => (
          <button
            key={topic.id}
            type="button"
            data-testid={`learning-topic-${topic.id}`}
            onClick={() => setSelectedId(topic.id)}
            className={`text-left rounded-lg px-3 py-2 text-xs transition-colors cursor-pointer ${
              selectedId === topic.id
                ? 'bg-sky-600 text-white font-semibold'
                : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wider opacity-75">{topic.category}</div>
            <div className="mt-0.5">{topic.title}</div>
          </button>
        ))}
      </nav>

      {/* Right Topic Detail Panel */}
      <article
        aria-label="Selected Learning Module Detail"
        className="lg:col-span-8 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 flex flex-col gap-5"
      >
        <div className="border-b border-slate-200 dark:border-slate-800 pb-4">
          <span className="inline-block rounded-md bg-sky-500/15 text-sky-700 dark:text-sky-300 px-2.5 py-0.5 text-xs font-mono font-medium">
            {activeTopic.category}
          </span>
          <h3 data-testid="learning-active-title" className="text-lg font-bold mt-2">
            {activeTopic.title}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{activeTopic.summary}</p>
        </div>

        <div className="space-y-4 text-xs leading-relaxed">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
            <h4 className="font-semibold text-sm flex items-center gap-1.5 mb-1.5">
              <CheckCircle className="w-4 h-4 text-emerald-500" aria-hidden="true" />
              How It Works in the Validated CPU GKE Stack
            </h4>
            <p className="text-slate-700 dark:text-slate-300">{activeTopic.howItWorks}</p>
          </div>

          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
            <h4 className="font-semibold text-sm flex items-center gap-1.5 mb-1.5 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-500" aria-hidden="true" />
              Observability Classification & Honest Boundaries
            </h4>
            <p className="text-amber-900 dark:text-amber-100">{activeTopic.observabilityBoundary}</p>
          </div>

          <div>
            <h4 className="font-semibold text-sm flex items-center gap-1.5 mb-2">
              <Code2 className="w-4 h-4 text-sky-500" aria-hidden="true" />
              Reference Configuration / Code Contract
            </h4>
            <pre className="rounded-lg bg-slate-950 text-slate-100 p-4 font-mono text-xs overflow-x-auto">
              {activeTopic.configSnippet}
            </pre>
          </div>
        </div>
      </article>
    </div>
  );
};
