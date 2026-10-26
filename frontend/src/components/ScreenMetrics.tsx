import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { BarChart3, RefreshCw, Info, Server, Cpu, Activity, CheckCircle2 } from 'lucide-react';
import { MetricsSummary, RequestRecord } from '../types/observatory';
import { ObservationBadge } from './ObservationBadge';

interface ScreenMetricsProps {
  metrics: MetricsSummary | null;
  activeRecord: RequestRecord | null;
  onRefresh: () => void;
}

export const ScreenMetrics: React.FC<ScreenMetricsProps> = ({
  metrics,
  activeRecord,
  onRefresh,
}) => {
  if (!metrics) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-sm text-slate-500">
        Loading system-wide aggregate telemetry metrics...
      </div>
    );
  }

  const recentSamples = metrics.recent_ttft_samples_ms ?? [];
  const recentItl = metrics.recent_itl_samples_ms ?? [];
  const ttftChartData = recentSamples.map((val, i) => ({
    req: `#${i + 1}`,
    ttft_ms: val,
    itl_ms: recentItl[i] ?? 0,
  }));

  const getMetricVal = (name: string): number | null => {
    const found = metrics.series.find((s) => s.name === name);
    return found?.value ?? null;
  };

  const obsCompleted = getMetricVal('observer_requests_completed_total') ?? 0;
  const obsRejectedPre = getMetricVal('observer_requests_rejected_prerouting_total') ?? 0;
  const obsUpstreamErr = getMetricVal('observer_requests_upstream_error_total') ?? 0;
  const eppRouted = getMetricVal('llm_d_epp_request_total');
  const eppErrors = getMetricVal('llm_d_epp_request_error_total');

  const categories: Array<{ key: string; title: string; subtitle: string; icon: React.ReactNode }> = [
    {
      key: 'observer',
      title: 'Observer API Rolling Latency & Request Counters',
      subtitle: 'In-process monotonic latency percentiles and request outcome counters',
      icon: <Activity className="w-4 h-4 text-sky-500" aria-hidden="true" />,
    },
    {
      key: 'epp',
      title: 'llm-d Endpoint Picker (EPP :9090/metrics)',
      subtitle: 'InferencePool readiness, routed totals, flow-control queues, and 64-token KV block hits',
      icon: <Server className="w-4 h-4 text-indigo-500" aria-hidden="true" />,
    },
    {
      key: 'vllm',
      title: 'vLLM CPU Model Server (:8000/metrics)',
      subtitle: 'Continuous-batching scheduler queues and prefix-cache hit rate across CPU pods',
      icon: <BarChart3 className="w-4 h-4 text-emerald-500" aria-hidden="true" />,
    },
    {
      key: 'resource',
      title: 'GKE Node Pool Resource Utilization (c3-standard-22)',
      subtitle: 'Intel Xeon Sapphire Rapids AMX CPU and DDR5 memory headroom',
      icon: <Cpu className="w-4 h-4 text-amber-500" aria-hidden="true" />,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Scope Separation Banner: Per-Request vs System-Wide Aggregate */}
      <section
        aria-label="Aggregate Metrics Scope Notice"
        data-testid="aggregate-metrics-notice"
        className="rounded-xl border border-indigo-500/35 bg-indigo-500/10 p-4 flex flex-wrap items-center justify-between gap-4"
      >
        <div className="flex items-start gap-3 max-w-4xl">
          <Info className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs">
            <div className="font-bold text-sm flex flex-wrap items-center gap-2">
              <span>System-Wide Aggregate Metrics vs. Per-Request Timings</span>
              <ObservationBadge kind={metrics.observation_scope} />
            </div>
            <p className="text-slate-700 dark:text-slate-300 mt-1">{metrics.scope_notice}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-600 dark:text-slate-400">
              <span>
                EPP Scrape: <strong>{metrics.epp_scrape_status}</strong>
              </span>
              <span>•</span>
              <span>
                vLLM Scrape: <strong>{metrics.vllm_scrape_status}</strong>
              </span>
              <span>•</span>
              <span>Collected: {metrics.collected_at.split('T')[1] || metrics.collected_at}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          data-testid="refresh-metrics-button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer shadow-2xs"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          Refresh Scrape
        </button>
      </section>

      {/* Side-by-Side Comparison: Selected Single Request vs Rolling Aggregate Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <section
          aria-label="Selected Single-Request Measured Timings"
          className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
        >
          <h3 className="text-sm font-bold border-b border-slate-200 dark:border-slate-800 pb-2.5 mb-3">
            Active Request Timings (Single-Request Scope)
          </h3>
          {activeRecord ? (
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Request ID:</span>
                <code className="font-mono font-semibold text-sky-700 dark:text-sky-300">
                  {activeRecord.request_id}
                </code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">True TTFT:</span>
                <span className="font-mono font-bold flex items-center gap-1.5">
                  {activeRecord.timings.ttft_ms.value !== null
                    ? `${activeRecord.timings.ttft_ms.value} ms`
                    : 'N/A'}
                  <ObservationBadge kind={activeRecord.timings.ttft_ms.observation_kind} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Mean ITL:</span>
                <span className="font-mono font-bold flex items-center gap-1.5">
                  {activeRecord.timings.mean_itl_ms.value !== null
                    ? `${activeRecord.timings.mean_itl_ms.value} ms`
                    : 'N/A'}
                  <ObservationBadge kind={activeRecord.timings.mean_itl_ms.observation_kind} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Decode Throughput:</span>
                <span className="font-mono font-bold flex items-center gap-1.5">
                  {activeRecord.timings.decode_tokens_per_sec.value !== null
                    ? `${activeRecord.timings.decode_tokens_per_sec.value} tok/s`
                    : 'N/A'}
                  <ObservationBadge kind={activeRecord.timings.decode_tokens_per_sec.observation_kind} />
                </span>
              </div>
              <div className="flex items-center justify-between pt-1.5 border-t border-slate-200 dark:border-slate-800">
                <span className="text-slate-500">Token Provenance:</span>
                <span className="font-mono font-semibold">
                  {activeRecord.timings.prompt_tokens} in ({activeRecord.timings.prompt_tokens_source || 'estimate'}) /{' '}
                  {activeRecord.timings.completion_tokens} out
                </span>
              </div>
              {activeRecord.timings.epp_token_count !== undefined && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">EPP Token Producer:</span>
                  <span className="font-mono font-semibold">
                    {activeRecord.timings.epp_token_count} tok ({activeRecord.timings.epp_token_backend || 'epp'})
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Selected Endpoint:</span>
                <code className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 truncate max-w-[230px]">
                  {activeRecord.selected_endpoint || 'unobserved'}
                </code>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500 leading-relaxed">
              No individual request selected yet. Run a request in the Playground to compare single-request measurements against system-wide aggregates.
            </p>
          )}
        </section>

        <section
          aria-label="Rolling Latency Chart"
          className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2.5 mb-3">
            <h3 className="text-sm font-bold">
              Rolling Request TTFT &amp; Mean ITL Distribution (ms)
            </h3>
            <span className="text-[11px] font-mono text-slate-500">
              {ttftChartData.length} recent sample{ttftChartData.length === 1 ? '' : 's'}
            </span>
          </div>
          {ttftChartData.length === 0 ? (
            <div className="h-44 flex items-center justify-center text-xs text-slate-500">
              Submit one or more streaming requests to populate the rolling TTFT / ITL chart.
            </div>
          ) : (
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ttftChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                  <XAxis dataKey="req" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} unit=" ms" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f172a',
                      borderColor: '#334155',
                      borderRadius: '0.5rem',
                      color: '#f8fafc',
                      fontSize: '12px',
                    }}
                  />
                  <Bar
                    dataKey="ttft_ms"
                    name="True TTFT (ms)"
                    fill="#0284c7"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="itl_ms"
                    name="Mean ITL (ms)"
                    fill="#8b5cf6"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>

      {/* Counter Reconciliation & Token Semantics Card */}
      <section
        aria-label="Counter Reconciliation and Token Measurement Semantics"
        data-testid="counter-reconciliation-card"
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-xs">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="font-bold text-sm flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-hidden="true" />
              Request Counter Reconciliation (Observer vs. EPP)
            </h3>
          </div>
          {eppRouted !== null && (
            <div className="mb-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 font-mono text-[11px] flex flex-wrap items-center justify-between gap-2">
              <span>
                Completed (<strong>{obsCompleted}</strong>) + Routed Errors (<strong>{obsUpstreamErr}</strong>) = EPP Routed (<strong>{eppRouted}</strong>)
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                Pre-Routing Rejects: <strong>{obsRejectedPre}</strong> | EPP Errors: <strong>{eppErrors ?? 0}</strong>
              </span>
            </div>
          )}
          <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
            <code className="font-mono">llm_d_epp_request_total</code> counts requests that EPP{' '}
            <strong>scheduled and routed to a model server</strong> (HTTP <code className="font-mono">200</code>{' '}
            + routed upstream <code className="font-mono">4xx/5xx ModelServerError</code>). Pre-routing rejections
            (HTTP <code className="font-mono">429</code> saturation or HTTP <code className="font-mono">503</code>{' '}
            zero-endpoint <code className="font-mono">ServiceUnavailable</code>) increment{' '}
            <code className="font-mono">observer_requests_rejected_prerouting_total</code> and{' '}
            <code className="font-mono">llm_d_epp_request_error_total</code> without incrementing{' '}
            <code className="font-mono">llm_d_epp_request_total</code>.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-xs">
          <h3 className="font-bold text-sm mb-2">
            Token Count Provenance (vLLM Usage vs. EPP Tokenize vs. Estimate)
          </h3>
          <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
            Observer forwards <code className="font-mono">stream_options.include_usage=true</code> so{' '}
            <code className="font-mono">vLLM</code> returns exact subword{' '}
            <code className="font-mono">usage.prompt_tokens</code> (source:{' '}
            <code className="font-mono">vllm_usage</code>, including ChatML template framing). EPP&apos;s{' '}
            <code className="font-mono">tokenize</code> span records{' '}
            <code className="font-mono">llm_d.epp.token_producer.token_count</code> via{' '}
            <code className="font-mono">/v1/chat/completions/render</code> (<code className="font-mono">backend=vllm</code>)
            or character estimation (<code className="font-mono">backend=estimate</code>).
          </p>
        </div>
      </section>

      {/* Categorized Aggregate Metric Cards */}
      {categories.map((cat) => {
        const items = metrics.series.filter((s) => s.category === cat.key);
        if (items.length === 0) return null;
        return (
          <section
            key={cat.key}
            aria-label={cat.title}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3 mb-4">
              <div className="flex items-center gap-2">
                {cat.icon}
                <div>
                  <h3 className="text-sm font-bold">{cat.title}</h3>
                  <p className="text-[11px] text-slate-500">{cat.subtitle}</p>
                </div>
              </div>
              <span className="text-[11px] font-mono text-slate-500">{items.length} metrics</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((item) => (
                <div
                  key={item.name}
                  data-testid={`metric-card-${item.name}`}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 p-3 flex flex-col justify-between gap-2"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold leading-snug">{item.label}</span>
                      <ObservationBadge kind={item.observation_kind} />
                    </div>
                    <code className="block text-[10px] font-mono text-slate-500 mt-0.5 break-all">
                      {item.name}
                    </code>
                  </div>

                  <div className="text-lg font-mono font-bold tracking-tight">
                    {item.value !== null ? `${item.value} ${item.unit}` : 'Unavailable'}
                  </div>

                  <details className="disclosure-box text-[11px] text-slate-500 border-t border-slate-200/70 dark:border-slate-800/80 pt-1.5">
                    <summary className="text-[10px] font-mono text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                      Source: {item.source} (details)
                    </summary>
                    <p className="mt-1 text-slate-600 dark:text-slate-400 leading-relaxed">
                      {item.explanation}
                    </p>
                  </details>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
