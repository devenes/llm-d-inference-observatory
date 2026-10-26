import React, { useState } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  Terminal,
  Sparkles,
  Network,
  Clock,
  SlidersHorizontal,
} from 'lucide-react';
import { RequestRecord, ServerConfig } from '../types/observatory';
import { ObservationBadge } from './ObservationBadge';

interface ScreenPlaygroundProps {
  config: ServerConfig;
  prompt: string;
  setPrompt: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  routerMode: string;
  setRouterMode: (v: string) => void;
  priorityBand: string;
  setPriorityBand: (v: string) => void;
  temperature: number;
  setTemperature: (v: number) => void;
  maxTokens: number;
  setMaxTokens: (v: number) => void;
  stream: boolean;
  setStream: (v: boolean) => void;
  scenario: string;
  setScenario: (v: string) => void;
  isRunning: boolean;
  outputText: string;
  errorText: string;
  activeRecord: RequestRecord | null;
  onSend: () => void;
  onCancel: () => void;
  onClear: () => void;
  onRetry: () => void;
  onNavigateTab?: (tab: 'playground' | 'timeline' | 'topology' | 'metrics' | 'learning') => void;
}

const PRESET_PROMPTS = [
  {
    label: 'Prefix-Cache Routing (>=64-tok block)',
    text: 'Architecture context: On CPU-only Google Kubernetes Engine (c3-standard-22 Intel Sapphire Rapids with AMX BF16), vLLM indexes KV cache in 64-token blocks (--block-size=64) and publishes ZMQ block events on port 5556. Question: Explain how the llm-d Endpoint Picker (EPP) uses ZMQ-backed precise prefix-cache affinity filtering and vLLM render tokenization to route warm requests.',
  },
  {
    label: 'Flow-Control Priority Shedding',
    text: 'Describe how llm-d flow control protects interactive traffic (priority 100) from best-effort batch saturation (priority -10) using concurrency detection.',
  },
  {
    label: 'True TTFT vs Header Latency',
    text: 'Why does HTTP 200 header arrival differ from True Time To First Token (TTFT) in OpenAI-compatible SSE streaming from vLLM?',
  },
];

export const ScreenPlayground: React.FC<ScreenPlaygroundProps> = ({
  config,
  prompt,
  setPrompt,
  model,
  setModel,
  routerMode,
  setRouterMode,
  priorityBand,
  setPriorityBand,
  temperature,
  setTemperature,
  maxTokens,
  setMaxTokens,
  stream,
  setStream,
  scenario,
  setScenario,
  isRunning,
  outputText,
  errorText,
  activeRecord,
  onSend,
  onCancel,
  onClear,
  onRetry,
  onNavigateTab,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyDetails = async () => {
    if (!activeRecord) return;
    const payload = {
      request_id: activeRecord.request_id,
      trace_id: activeRecord.trace_id,
      model: activeRecord.model,
      router_mode: activeRecord.router_mode,
      priority_band: activeRecord.priority_band,
      mock_mode: activeRecord.mock_mode,
      scenario: activeRecord.scenario,
      status: activeRecord.status,
      selected_endpoint: activeRecord.selected_endpoint,
      timings: activeRecord.timings,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback ignored in headless environments without clipboard permission
    }
  };

  const hasEvent = (t: string) => activeRecord?.events?.some((e) => e.event_type === t) ?? false;

  const lifecyclePills = [
    { label: '1. Accepted', done: isRunning || hasEvent('request.accepted') },
    { label: '2. Gateway', done: isRunning || hasEvent('gateway.forwarded') },
    { label: '3. EPP Routed', done: Boolean(activeRecord?.selected_endpoint) || hasEvent('endpoint.selected') },
    { label: '4. True TTFT', done: Boolean(outputText) || hasEvent('model.first_token') },
    {
      label: '5. Complete',
      done: activeRecord?.status === 'completed',
      failed: activeRecord?.status === 'failed' || activeRecord?.status === 'cancelled',
    },
  ];

  const ttftVal = activeRecord?.timings?.ttft_ms?.value ?? null;
  const totalVal = activeRecord?.timings?.total_duration_ms?.value ?? null;
  const ttftPct =
    ttftVal !== null && totalVal !== null && totalVal > 0
      ? Math.min(92, Math.max(8, Math.round((ttftVal / totalVal) * 100)))
      : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left Column: Prompt Composer & Routing Controls */}
      <section
        aria-label="Inference Request Controls"
        className="lg:col-span-5 flex flex-col gap-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-bold tracking-tight">Prompt &amp; Routing Controls</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Send an OpenAI-compatible request through the Observer API to trace its live journey.
            </p>
          </div>
          {config.mock_mode && <ObservationBadge kind="simulated" />}
        </div>

        {/* Preset Prompt Pills */}
        <div>
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
            Guided Prompt Templates
          </span>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setPrompt(p.text)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 text-xs font-medium hover:border-sky-500/50 hover:bg-sky-500/5 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3 h-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Prompt Textarea */}
        <div>
          <label htmlFor="prompt-editor" className="block text-xs font-semibold mb-1.5">
            Prompt Input
          </label>
          <textarea
            id="prompt-editor"
            data-testid="prompt-input"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter a prompt to trace across Observer API → Envoy → EPP → vLLM CPU..."
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>

        {/* Primary Routing Selectors: Model & Router Profile */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="model-select" className="block text-xs font-semibold mb-1">
              Target CPU Model
            </label>
            <select
              id="model-select"
              data-testid="model-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono"
            >
              {config.allowed_models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="router-mode-select" className="block text-xs font-semibold mb-1">
              llm-d Router Profile
            </label>
            <select
              id="router-mode-select"
              data-testid="router-mode-select"
              value={routerMode}
              onChange={(e) => setRouterMode(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono"
            >
              {config.router_modes.map((rm) => (
                <option key={rm} value={rm}>
                  {rm}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Priority Band & Mock Scenario */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="priority-band-select" className="block text-xs font-semibold mb-1">
              InferenceObjective Priority
            </label>
            <select
              id="priority-band-select"
              data-testid="priority-band-select"
              value={priorityBand}
              onChange={(e) => setPriorityBand(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono"
            >
              {config.priority_bands.map((pb) => (
                <option key={pb} value={pb}>
                  {pb}
                </option>
              ))}
            </select>
          </div>

          {config.mock_mode && (
            <div>
              <label
                htmlFor="scenario-select"
                className="block text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1"
              >
                Simulated Demo Scenario
              </label>
              <select
                id="scenario-select"
                data-testid="scenario-select"
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                className="w-full rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-mono"
              >
                {config.mock_scenarios.map((sc) => (
                  <option key={sc} value={sc}>
                    {sc}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Generation Parameters Strip */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 mb-2">
            <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Generation Parameters</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label htmlFor="temperature-input" className="block text-xs font-medium mb-1">
                Temp ({temperature.toFixed(1)})
              </label>
              <input
                id="temperature-input"
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <label htmlFor="max-tokens-input" className="block text-xs font-medium mb-1">
                Max Tokens
              </label>
              <input
                id="max-tokens-input"
                data-testid="max-tokens-input"
                type="number"
                min={1}
                max={config.max_output_tokens}
                value={maxTokens}
                onChange={(e) =>
                  setMaxTokens(
                    Math.max(1, Math.min(config.max_output_tokens, Number(e.target.value) || 1)),
                  )
                }
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
              />
            </div>

            <div className="flex items-center gap-2 pb-1">
              <input
                id="stream-toggle"
                data-testid="stream-toggle"
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <label htmlFor="stream-toggle" className="text-xs font-semibold select-none">
                SSE Stream
              </label>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            data-testid="send-button"
            disabled={isRunning || !prompt.trim()}
            onClick={onSend}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-4 py-2 text-xs font-semibold transition-colors cursor-pointer shadow-xs"
          >
            <Play className="w-3.5 h-3.5" aria-hidden="true" />
            {isRunning ? 'Streaming...' : 'Send Request'}
          </button>

          <button
            type="button"
            data-testid="cancel-button"
            disabled={!isRunning}
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/50 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 text-rose-700 dark:text-rose-300 px-3 py-2 text-xs font-semibold transition-colors cursor-pointer"
          >
            <Square className="w-3.5 h-3.5" aria-hidden="true" />
            Cancel
          </button>

          <button
            type="button"
            data-testid="retry-button"
            disabled={isRunning || !prompt.trim()}
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 px-3 py-2 text-xs font-medium transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </button>

          <button
            type="button"
            data-testid="clear-button"
            disabled={isRunning}
            onClick={onClear}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 px-3 py-2 text-xs font-medium transition-colors cursor-pointer ml-auto"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            Clear
          </button>
        </div>
      </section>

      {/* Right Column: Live Response Stream, Stage Flow & Latency Breakdown */}
      <section
        aria-label="Live Inference Output and Request Correlation"
        className="lg:col-span-7 flex flex-col gap-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
            <h2 className="text-base font-bold tracking-tight">Live Response Stream &amp; Telemetry</h2>
          </div>

          {activeRecord && (
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="request-status-badge"
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase ${
                  activeRecord.status === 'completed'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : activeRecord.status === 'cancelled'
                      ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                      : activeRecord.status === 'failed'
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                        : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                }`}
              >
                {activeRecord.status}
              </span>

              {onNavigateTab && (
                <button
                  type="button"
                  onClick={() => onNavigateTab('topology')}
                  className="inline-flex items-center gap-1 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/30 px-2.5 py-1 text-xs font-semibold cursor-pointer"
                >
                  <Network className="w-3.5 h-3.5" aria-hidden="true" />
                  Inspect Topology
                </button>
              )}

              <button
                type="button"
                data-testid="copy-request-details"
                onClick={handleCopyDetails}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                    Copied JSON
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    Copy JSON
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Visual Lifecycle Progress Strip */}
        <div className="grid grid-cols-5 gap-1.5">
          {lifecyclePills.map((st) => (
            <div
              key={st.label}
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium flex items-center justify-between gap-1 ${
                st.failed
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                  : st.done
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-400'
              }`}
            >
              <span className="truncate">{st.label}</span>
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  st.failed ? 'bg-rose-500' : st.done ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              />
            </div>
          ))}
        </div>

        {/* Request Correlation Summary Strip */}
        {activeRecord ? (
          <div className="flex flex-col gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950 p-3.5 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Request ID
                </span>
                <code
                  data-testid="request-id-value"
                  className="font-mono font-semibold text-sky-700 dark:text-sky-300 break-all"
                >
                  {activeRecord.request_id}
                </code>
              </div>
              <div>
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  W3C Trace ID
                </span>
                <code
                  data-testid="trace-id-value"
                  className="font-mono font-semibold text-indigo-700 dark:text-indigo-300 break-all"
                >
                  {activeRecord.trace_id || 'unavailable'}
                </code>
              </div>
              <div>
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Actual Selected Endpoint
                </span>
                <code
                  data-testid="selected-endpoint-value"
                  className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 break-all"
                >
                  {activeRecord.selected_endpoint || 'unobserved (not inferred)'}
                </code>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 dark:border-slate-800 pt-2 text-[11px] text-slate-600 dark:text-slate-400 font-mono">
              <span data-testid="playground-token-provenance">
                Tokens: <strong>{activeRecord.timings.prompt_tokens}</strong> in (
                {activeRecord.timings.prompt_tokens_source || 'observer_char_estimate'})
                {activeRecord.timings.epp_token_count !== undefined && (
                  <>
                    {' '}
                    | EPP tokenize: <strong>{activeRecord.timings.epp_token_count}</strong> (
                    {activeRecord.timings.epp_token_backend || 'epp'})
                  </>
                )}{' '}
                | <strong>{activeRecord.timings.completion_tokens}</strong> out (
                {activeRecord.timings.completion_tokens_source || 'sse_chunk_count'})
              </span>
              {activeRecord.candidate_endpoints && activeRecord.candidate_endpoints.length > 0 && (
                <span data-testid="playground-candidate-endpoints" className="text-slate-500">
                  Candidates: [{activeRecord.candidate_endpoints.join(', ')}]
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 p-3.5 text-xs text-slate-500">
            No active request yet. Click <strong>Send Request</strong> to assign a Request ID, propagate W3C trace context, and stream tokens.
          </div>
        )}

        {/* Error Banner if request failed */}
        {errorText && (
          <div
            role="alert"
            data-testid="playground-error-alert"
            className="flex items-start gap-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-800 dark:text-rose-200"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <div className="font-semibold">Upstream / Request Failure Observed</div>
              <div className="font-mono mt-0.5 break-all">{errorText}</div>
            </div>
          </div>
        )}

        {/* Streaming Output Box */}
        <div className="flex-1 min-h-[175px] rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap relative">
          {outputText ? (
            <div data-testid="stream-output-text">
              {outputText}
              {isRunning && (
                <span
                  aria-hidden="true"
                  className="inline-block w-2 h-3.5 ml-1 bg-sky-400 align-middle animate-pulse"
                />
              )}
            </div>
          ) : (
            <span className="text-slate-500">
              {isRunning
                ? 'Waiting for first non-empty token from vLLM model server...'
                : 'Generated tokens will stream here in real time.'}
            </span>
          )}
        </div>

        {/* Measured Per-Request Timing Summary & Visual Proportion Bar */}
        {activeRecord && (
          <div className="space-y-3 pt-1">
            {ttftPct !== null && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2.5 text-xs">
                <div className="flex items-center justify-between text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3 text-sky-500" aria-hidden="true" />
                    Latency Split: Waiting for First Token ({ttftPct}%) vs. Streaming Decode ({100 - ttftPct}%)
                  </span>
                  <span className="font-mono">
                    {ttftVal} ms TTFT / {totalVal} ms Total
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden flex">
                  <div
                    style={{ width: `${ttftPct}%` }}
                    className="bg-sky-500 h-full"
                    title={`True TTFT: ${ttftVal} ms`}
                  />
                  <div
                    style={{ width: `${100 - ttftPct}%` }}
                    className="bg-emerald-500 h-full"
                    title={`Streaming Decode: ${((totalVal || 0) - (ttftVal || 0)).toFixed(1)} ms`}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                  <span>True TTFT</span>
                  <ObservationBadge kind={activeRecord.timings.ttft_ms.observation_kind} />
                </div>
                <div data-testid="playground-ttft-ms" className="text-sm font-mono font-bold">
                  {activeRecord.timings.ttft_ms.value !== null
                    ? `${activeRecord.timings.ttft_ms.value} ms`
                    : 'N/A'}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                  <span>HTTP Headers</span>
                  <ObservationBadge kind={activeRecord.timings.upstream_headers_ms.observation_kind} />
                </div>
                <div className="text-sm font-mono font-bold">
                  {activeRecord.timings.upstream_headers_ms.value !== null
                    ? `${activeRecord.timings.upstream_headers_ms.value} ms`
                    : 'N/A'}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                  <span>Mean ITL</span>
                  <ObservationBadge kind={activeRecord.timings.mean_itl_ms.observation_kind} />
                </div>
                <div className="text-sm font-mono font-bold">
                  {activeRecord.timings.mean_itl_ms.value !== null
                    ? `${activeRecord.timings.mean_itl_ms.value} ms`
                    : 'N/A'}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                  <span>E2E Duration</span>
                  <ObservationBadge kind={activeRecord.timings.total_duration_ms.observation_kind} />
                </div>
                <div className="text-sm font-mono font-bold">
                  {activeRecord.timings.total_duration_ms.value !== null
                    ? `${activeRecord.timings.total_duration_ms.value} ms`
                    : 'N/A'}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
