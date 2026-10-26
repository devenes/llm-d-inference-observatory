import React, { useState } from 'react';
import { Play, Square, RotateCcw, Trash2, Copy, Check, AlertTriangle, Terminal, Sparkles } from 'lucide-react';
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
}

const PRESET_PROMPTS = [
  {
    label: 'Prefix-Cache Routing on CPU (>=64-tok block)',
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Prompt & Generation Controls */}
      <section
        aria-label="Inference Request Controls"
        className="lg:col-span-5 flex flex-col gap-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Inference Playground</h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Submit an OpenAI-compatible request through the Observer API to inspect the llm-d lifecycle.
            </p>
          </div>
          {config.mock_mode && <ObservationBadge kind="simulated" />}
        </div>

        {/* Preset Prompt Pills */}
        <div>
          <span className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            Sample Architecture Prompts
          </span>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setPrompt(p.text)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <Sparkles className="w-3 h-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Prompt Textarea */}
        <div>
          <label htmlFor="prompt-editor" className="block text-xs font-semibold mb-1">
            Prompt Input
          </label>
          <textarea
            id="prompt-editor"
            data-testid="prompt-input"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter a prompt to trace across Observer API -> Envoy -> EPP -> vLLM CPU..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>

        {/* Model & Router Mode Selectors */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="model-select" className="block text-xs font-semibold mb-1">
              Configured CPU Model
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
              InferenceObjective Priority Band
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
              <label htmlFor="scenario-select" className="block text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">
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

        {/* Temperature, Max Tokens & Streaming Toggle */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-1">
          <div>
            <label htmlFor="temperature-input" className="block text-xs font-semibold mb-1">
              Temperature ({temperature.toFixed(1)})
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
            <label htmlFor="max-tokens-input" className="block text-xs font-semibold mb-1">
              Max Output Tokens
            </label>
            <input
              id="max-tokens-input"
              data-testid="max-tokens-input"
              type="number"
              min={1}
              max={config.max_output_tokens}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Math.max(1, Math.min(config.max_output_tokens, Number(e.target.value) || 1)))}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-mono"
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
              SSE Token Stream
            </label>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            data-testid="send-button"
            disabled={isRunning || !prompt.trim()}
            onClick={onSend}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-4 py-2 text-xs font-semibold transition-colors cursor-pointer"
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

      {/* Right Column: Live Output Stream & Correlated Request Details */}
      <section
        aria-label="Live Inference Output and Request Correlation"
        className="lg:col-span-7 flex flex-col gap-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
            <h2 className="text-base font-semibold tracking-tight">Live Response Stream & Telemetry Header</h2>
          </div>

          {activeRecord && (
            <div className="flex items-center gap-2">
              <span
                data-testid="request-status-badge"
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-xs font-semibold uppercase ${
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
              <button
                type="button"
                data-testid="copy-request-details"
                onClick={handleCopyDetails}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                    Copied JSON
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    Copy Details
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Request ID & Trace ID Correlation Strip */}
        {activeRecord ? (
          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <span className="block text-[11px] uppercase tracking-wider text-slate-500">Request ID</span>
                <code data-testid="request-id-value" className="font-mono font-semibold text-sky-700 dark:text-sky-300 break-all">
                  {activeRecord.request_id}
                </code>
              </div>
              <div>
                <span className="block text-[11px] uppercase tracking-wider text-slate-500">W3C Trace ID</span>
                <code data-testid="trace-id-value" className="font-mono font-semibold text-indigo-700 dark:text-indigo-300 break-all">
                  {activeRecord.trace_id || 'unavailable'}
                </code>
              </div>
              <div>
                <span className="block text-[11px] uppercase tracking-wider text-slate-500">
                  Actual Selected Endpoint
                </span>
                <code data-testid="selected-endpoint-value" className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 break-all">
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
                <span data-testid="playground-candidate-endpoints">
                  EPP Candidates (pick_endpoints): [{activeRecord.candidate_endpoints.join(', ')}]
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-800 p-3 text-xs text-slate-500">
            No active request yet. Click <strong>Send Request</strong> to assign a Request ID, propagate W3C trace context, and stream tokens.
          </div>
        )}

        {/* Error Banner if request failed */}
        {errorText && (
          <div
            role="alert"
            data-testid="playground-error-alert"
            className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-800 dark:text-rose-200"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <div className="font-semibold">Upstream / Request Failure Observed</div>
              <div className="font-mono mt-0.5 break-all">{errorText}</div>
            </div>
          </div>
        )}

        {/* Streaming Output Box */}
        <div className="flex-1 min-h-[160px] rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {outputText ? (
            <div data-testid="stream-output-text">{outputText}</div>
          ) : (
            <span className="text-slate-500">
              {isRunning ? 'Waiting for first non-empty token from model server...' : 'Generated tokens will stream here in real time.'}
            </span>
          )}
        </div>

        {/* Measured Per-Request Timing Summary Cards */}
        {activeRecord && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
              <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                <span>True TTFT</span>
                <ObservationBadge kind={activeRecord.timings.ttft_ms.observation_kind} />
              </div>
              <div data-testid="playground-ttft-ms" className="text-sm font-mono font-bold">
                {activeRecord.timings.ttft_ms.value !== null ? `${activeRecord.timings.ttft_ms.value} ms` : 'N/A'}
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
                {activeRecord.timings.mean_itl_ms.value !== null ? `${activeRecord.timings.mean_itl_ms.value} ms` : 'N/A'}
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
        )}
      </section>
    </div>
  );
};
