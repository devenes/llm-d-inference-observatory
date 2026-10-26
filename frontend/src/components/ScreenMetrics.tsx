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
import { BarChart3, RefreshCw, Info, Server, Cpu, Activity } from 'lucide-react';
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

  const ttftChartData = metrics.recent_ttft_samples_ms.map((val, i) => ({
    req: `#${i + 1}`,
    ttft_ms: val,
    itl_ms: metrics.recent_itl_samples_ms[i] ?? 0,
  }));

  const categories: Array<{ key: string; title: string; icon: React.ReactNode }> = [
    {
      key: 'observer',
      title: 'Observer API Rolling Latency & Request Counters',
      icon: <Activity className="w-4 h-4 text-sky-500" aria-hidden="true" />,
    },
    {
      key: 'epp',
      title: 'llm-d Endpoint Picker (EPP :9090/metrics)',
      icon: <Server className="w-4 h-4 text-indigo-500" aria-hidden="true" />,
    },
    {
      key: 'vllm',
      title: 'vLLM CPU Model Server (:8000/metrics)',
      icon: <BarChart3 className="w-4 h-4 text-emerald-500" aria-hidden="true" />,
    },
    {
      key: 'resource',
      title: 'GKE Node Pool Resource Utilization (c3-standard-22)',
      icon: <Cpu className="w-4 h-4 text-amber-500" aria-hidden="true" />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Scope Separation Banner: Per-Request vs System-Wide Aggregate */}
      <section
        aria-label="Aggregate Metrics Scope Notice"
        data-testid="aggregate-metrics-notice"
        className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-4 flex flex-wrap items-start justify-between gap-4"
      >
        <div className="flex items-start gap-3 max-w-4xl">
          <Info className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs">
            <div className="font-semibold text-sm flex items-center gap-2">
              <span>System-Wide Aggregate Metrics vs. Per-Request Timings</span>
              <ObservationBadge kind={metrics.observation_scope} />
            </div>
            <p className="text-slate-700 dark:text-slate-300 mt-1">{metrics.scope_notice}</p>
            <div className="mt-1.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
              EPP Scrape Status: <strong>{metrics.epp_scrape_status}</strong> | vLLM Scrape Status:{' '}
              <strong>{metrics.vllm_scrape_status}</strong> | Collected: {metrics.collected_at}
            </div>
          </div>
        </div>

        <button
          type="button"
          data-testid="refresh-metrics-button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          Refresh Scrape
        </button>
      </section>

      {/* Side-by-Side Comparison: Selected Single Request vs Rolling Aggregate Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section
          aria-label="Selected Single-Request Measured Timings"
          className="lg:col-span-5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5"
        >
          <h3 className="text-sm font-semibold border-b border-slate-200 dark:border-slate-800 pb-2.5 mb-3">
            Active Request Measured Timings (Single-Request Scope)
          </h3>
          {activeRecord ? (
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Request ID:</span>
                <code className="font-mono font-semibold">{activeRecord.request_id}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">True TTFT:</span>
                <span className="font-mono font-bold">
                  {activeRecord.timings.ttft_ms.value !== null
                    ? `${activeRecord.timings.ttft_ms.value} ms`
                    : 'N/A'}{' '}
                  <ObservationBadge kind={activeRecord.timings.ttft_ms.observation_kind} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Mean ITL:</span>
                <span className="font-mono font-bold">
                  {activeRecord.timings.mean_itl_ms.value !== null
                    ? `${activeRecord.timings.mean_itl_ms.value} ms`
                    : 'N/A'}{' '}
                  <ObservationBadge kind={activeRecord.timings.mean_itl_ms.observation_kind} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Decode Throughput:</span>
                <span className="font-mono font-bold">
                  {activeRecord.timings.decode_tokens_per_sec.value !== null
                    ? `${activeRecord.timings.decode_tokens_per_sec.value} tok/s`
                    : 'N/A'}{' '}
                  <ObservationBadge kind={activeRecord.timings.decode_tokens_per_sec.observation_kind} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Input / Output Tokens:</span>
                <span className="font-mono font-bold">
                  {activeRecord.timings.prompt_tokens} in / {activeRecord.timings.completion_tokens} out
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              No individual request selected yet. Run a request in the Playground to compare single-request measurements against system-wide aggregates.
            </p>
          )}
        </section>

        <section
          aria-label="Rolling Latency Chart"
          className="lg:col-span-7 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5"
        >
          <h3 className="text-sm font-semibold border-b border-slate-200 dark:border-slate-800 pb-2.5 mb-3">
            Rolling Request TTFT & ITL Distribution (ms)
          </h3>
          {ttftChartData.length === 0 ? (
            <div className="h-44 flex items-center justify-center text-xs text-slate-500">
              Submit one or more streaming requests to populate the rolling TTFT/ITL chart.
            </div>
          ) : (
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ttftChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                  <XAxis dataKey="req" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} unit=" ms" />
                  <Tooltip />
                  <Bar dataKey="ttft_ms" name="True TTFT (ms)" fill="#0284c7" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="itl_ms" name="Mean ITL (ms)" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>

      {/* Categorized Aggregate Metric Cards */}
      {categories.map((cat) => {
        const items = metrics.series.filter((s) => s.category === cat.key);
        return (
          <section
            key={cat.key}
            aria-label={cat.title}
            className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5"
          >
            <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3 mb-4">
              {cat.icon}
              <h3 className="text-sm font-semibold">{cat.title}</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((item) => (
                <div
                  key={item.name}
                  data-testid={`metric-card-${item.name}`}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 flex flex-col justify-between gap-2"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold">{item.label}</span>
                      <ObservationBadge kind={item.observation_kind} />
                    </div>
                    <code className="block text-[11px] font-mono text-slate-500 mt-0.5">{item.name}</code>
                  </div>

                  <div className="text-lg font-mono font-bold">
                    {item.value !== null ? `${item.value} ${item.unit}` : 'Unavailable'}
                  </div>

                  <div className="text-[11px] text-slate-500 border-t border-slate-100 dark:border-slate-800/80 pt-1.5">
                    <div>{item.explanation}</div>
                    <div className="font-mono text-[10px] mt-0.5 opacity-80">Source: {item.source}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
