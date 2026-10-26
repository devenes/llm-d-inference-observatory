import React, { useMemo, useState } from 'react';
import {
  Clock,
  GitCommit,
  AlertCircle,
  CheckCircle2,
  Layers,
  Filter,
} from 'lucide-react';
import {
  EventEnvelope,
  RequestRecord,
  SpanNode,
  STAGE_EXPLANATIONS,
} from '../types/observatory';
import { ObservationBadge } from './ObservationBadge';

interface ScreenTimelineProps {
  record: RequestRecord | null;
}

export function sortLifecycleEvents(events: EventEnvelope[]): EventEnvelope[] {
  return [...events].sort((a, b) => {
    if (a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return a.source_timestamp.localeCompare(b.source_timestamp);
  });
}

export const ScreenTimeline: React.FC<ScreenTimelineProps> = ({ record }) => {
  const [collapseTokenChunks, setCollapseTokenChunks] = useState<boolean>(false);

  const sortedEvents = useMemo(() => {
    if (!record) return [];
    return sortLifecycleEvents(record.events);
  }, [record]);

  const visibleEvents = useMemo(() => {
    if (!collapseTokenChunks) return sortedEvents;
    return sortedEvents.filter((e) => e.event_type !== 'model.token');
  }, [sortedEvents, collapseTokenChunks]);

  const tokenChunkCount = useMemo(
    () => sortedEvents.filter((e) => e.event_type === 'model.token').length,
    [sortedEvents],
  );

  // Organize spans into parent-child depth levels and compute waterfall percentages
  const orderedSpans = useMemo(() => {
    if (!record?.trace?.spans?.length) return [];
    const spans = [...record.trace.spans];
    spans.sort((a, b) => a.start_time.localeCompare(b.start_time));

    const byId = new Map<string, SpanNode>();
    for (const s of spans) {
      byId.set(s.span_id, s);
    }

    const getDepth = (s: SpanNode): number => {
      let depth = 0;
      let curr: SpanNode | undefined = s;
      const visited = new Set<string>();
      while (curr?.parent_span_id && byId.has(curr.parent_span_id) && !visited.has(curr.span_id)) {
        visited.add(curr.span_id);
        depth += 1;
        curr = byId.get(curr.parent_span_id);
      }
      return Math.min(depth, 4);
    };

    const maxDurNs = Math.max(...spans.map((s) => s.duration_ns || 1), 1);

    return spans.map((sp) => ({
      span: sp,
      depth: getDepth(sp),
      widthPct: Math.max(4, Math.min(100, Math.round(((sp.duration_ns || 0) / maxDurNs) * 100))),
    }));
  }, [record]);

  if (!record) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-sm text-slate-500">
        No request selected. Submit a prompt in the <strong>Inference Playground</strong> to inspect the live lifecycle timeline and correlated OpenTelemetry spans.
      </div>
    );
  }

  const maxEventDurNs = Math.max(
    ...sortedEvents.map((e) => (e.duration_ns !== null ? e.duration_ns : 0)),
    1,
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Header & Key Timing Milestones */}
      <section
        aria-label="Request Lifecycle Summary"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-bold tracking-tight flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
              Live Request Lifecycle Timeline ({sortedEvents.length} events)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Correlated by sequence via Request ID{' '}
              <code className="font-mono font-semibold text-sky-700 dark:text-sky-300">
                {record.request_id}
              </code>{' '}
              and W3C Trace ID{' '}
              <code className="font-mono font-semibold text-indigo-700 dark:text-indigo-300">
                {record.trace_id}
              </code>
              .
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="trace-enrichment-status"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 text-xs font-mono"
            >
              Trace Status: <strong>{record.trace.status}</strong>
            </span>
            <ObservationBadge kind={record.trace.observation_kind} />
          </div>
        </div>

        {/* Three Core Timing Boundaries */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between font-semibold mb-1">
              <span>HTTP Headers Arrival</span>
              <ObservationBadge kind={record.timings.upstream_headers_ms.observation_kind} />
            </div>
            <div className="font-mono text-base font-bold">
              {record.timings.upstream_headers_ms.value !== null
                ? `${record.timings.upstream_headers_ms.value} ms`
                : 'Unavailable'}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {record.timings.upstream_headers_ms.explanation}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between font-semibold mb-1">
              <span>True TTFT (First Content Token)</span>
              <ObservationBadge kind={record.timings.ttft_ms.observation_kind} />
            </div>
            <div className="font-mono text-base font-bold">
              {record.timings.ttft_ms.value !== null ? `${record.timings.ttft_ms.value} ms` : 'Unavailable'}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{record.timings.ttft_ms.explanation}</p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between font-semibold mb-1">
              <span>Model-Server Prefill Span</span>
              <ObservationBadge kind={record.timings.prefill_duration_ms.observation_kind} />
            </div>
            <div data-testid="prefill-duration-value" className="font-mono text-base font-bold">
              {record.timings.prefill_duration_ms.value !== null
                ? `${record.timings.prefill_duration_ms.value} ms`
                : 'Unavailable'}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {record.timings.prefill_duration_ms.explanation}
            </p>
          </div>
        </div>

        {/* Endpoint Selection & Token Provenance Honesty Strip */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
            <div className="font-semibold mb-1">
              Actual Selected Endpoint vs. Candidate Rankings
            </div>
            <div
              data-testid="timeline-selected-endpoint"
              className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-300 break-all"
            >
              Selected (x-gateway-destination-endpoint):{' '}
              {record.selected_endpoint || 'Unavailable (never inferred from candidate rankings)'}
            </div>
            {record.candidate_endpoints && record.candidate_endpoints.length > 0 && (
              <div className="font-mono text-[11px] text-slate-500 mt-1 break-all">
                EPP Candidate Rankings (pick_endpoints): [{record.candidate_endpoints.join(', ')}]
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
            <div className="font-semibold mb-1">
              Token Count Provenance (vLLM Usage vs. EPP Token Producer)
            </div>
            <div data-testid="timeline-token-provenance" className="font-mono text-xs">
              Input: <strong>{record.timings.prompt_tokens}</strong> tokens (source:{' '}
              <code>{record.timings.prompt_tokens_source || 'observer_char_estimate'}</code>) | Output:{' '}
              <strong>{record.timings.completion_tokens}</strong> tokens (source:{' '}
              <code>{record.timings.completion_tokens_source || 'sse_chunk_count'}</code>)
            </div>
            <div className="font-mono text-[11px] text-slate-500 mt-1">
              EPP tokenize span:{' '}
              {record.timings.epp_token_count !== undefined
                ? `${record.timings.epp_token_count} tokens (backend: ${record.timings.epp_token_backend || 'epp'})`
                : 'Not recorded on trace'}
            </div>
          </div>
        </div>
      </section>

      {/* Chronological Lifecycle Table with Progressive Attribute Disclosure */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="text-xs text-slate-500">
            Showing <strong>{visibleEvents.length}</strong> of <strong>{sortedEvents.length}</strong> chronological events. Technical metadata expands on demand.
          </div>
          {tokenChunkCount > 2 && (
            <button
              type="button"
              onClick={() => setCollapseTokenChunks((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
              {collapseTokenChunks
                ? `Show ${tokenChunkCount} Decode Token Events`
                : `Hide ${tokenChunkCount} Individual Token Events`}
            </button>
          )}
        </div>

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="lifecycle-table-caption"
          className="table-wrapper rounded-lg border border-slate-200 dark:border-slate-800"
        >
          <table className="lifecycle-table text-left text-xs">
            <caption id="lifecycle-table-caption" className="sr-only">
              Chronological inference lifecycle events and observation classifications for request{' '}
              {record.request_id}
            </caption>
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                <th scope="col" className="p-3 font-semibold">
                  # / Stage Event
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Component
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Timestamp (UTC)
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Duration
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Classification
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Summary &amp; On-Demand Attributes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {visibleEvents.map((ev) => {
                const durMs =
                  ev.duration_ns !== null ? (ev.duration_ns / 1e6).toFixed(2) + ' ms' : '—';
                const barPct =
                  ev.duration_ns !== null && ev.duration_ns > 0
                    ? Math.max(6, Math.min(100, Math.round((ev.duration_ns / maxEventDurNs) * 100)))
                    : 0;
                const stageDesc = STAGE_EXPLANATIONS[ev.event_type] || 'Correlated lifecycle event.';
                const isFailure =
                  ev.event_type === 'request.failed' || ev.event_type === 'request.cancelled';
                const attrKeys = Object.keys(ev.attributes || {});

                return (
                  <tr
                    key={ev.event_id}
                    data-testid={`timeline-event-${ev.event_type}`}
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                  >
                    <th scope="row" className="p-3 font-mono font-semibold whitespace-nowrap align-top">
                      <div className="flex items-center gap-1.5">
                        {isFailure ? (
                          <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" aria-hidden="true" />
                        ) : (
                          <CheckCircle2
                            className="w-3.5 h-3.5 text-emerald-500 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span>
                          #{ev.sequence} {ev.event_type}
                        </span>
                      </div>
                    </th>
                    <td className="p-3 font-mono align-top">
                      <span className="inline-block rounded bg-slate-100 dark:bg-slate-800 px-2 py-0.5 font-medium">
                        {ev.component}
                      </span>
                      <div className="text-[10px] text-slate-500 mt-0.5">{ev.source}</div>
                    </td>
                    <td className="p-3 font-mono text-[11px] text-slate-600 dark:text-slate-400 whitespace-nowrap align-top">
                      {ev.source_timestamp.split('T')[1] || ev.source_timestamp}
                    </td>
                    <td className="p-3 font-mono font-semibold whitespace-nowrap align-top">
                      <div>{durMs}</div>
                      {barPct > 0 && (
                        <div className="h-1.5 w-20 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden mt-1">
                          <div
                            style={{ width: `${barPct}%` }}
                            className={`h-full rounded-full ${
                              isFailure ? 'bg-rose-500' : 'bg-sky-500'
                            }`}
                          />
                        </div>
                      )}
                    </td>
                    <td className="p-3 align-top">
                      <ObservationBadge kind={ev.observation_kind} />
                    </td>
                    <td className="p-3 align-top max-w-xl">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {ev.message}
                      </div>
                      <details className="disclosure-box mt-1 text-[11px] text-slate-500">
                        <summary className="text-[11px] text-sky-600 dark:text-sky-400">
                          {attrKeys.length > 0
                            ? `Stage explanation & ${attrKeys.length} attribute${attrKeys.length > 1 ? 's' : ''}`
                            : 'Stage explanation'}
                        </summary>
                        <div className="mt-1.5 space-y-1.5">
                          <p className="text-slate-600 dark:text-slate-400">{stageDesc}</p>
                          {attrKeys.length > 0 && (
                            <pre className="rounded bg-slate-100 dark:bg-slate-950 p-2 font-mono text-[11px] overflow-x-auto text-slate-800 dark:text-slate-200">
                              {JSON.stringify(ev.attributes, null, 2)}
                            </pre>
                          )}
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Correlated Distributed OpenTelemetry Trace Spans Waterfall */}
      <section
        aria-label="Correlated OpenTelemetry Trace Spans"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
            <h3 className="text-sm font-bold">
              Correlated Distributed Trace Waterfall ({record.trace.spans.length} spans)
            </h3>
          </div>
          <span className="text-xs font-mono text-slate-500">Backend: {record.trace.backend}</span>
        </div>

        {record.trace.error_message && (
          <div
            data-testid="trace-warning-banner"
            className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
          >
            <strong>Trace Note:</strong> {record.trace.error_message}
          </div>
        )}

        {orderedSpans.length === 0 ? (
          <p className="text-xs text-slate-500">
            {record.trace.status === 'pending'
              ? 'Waiting for asynchronous OpenTelemetry span flush from Collector / Jaeger...'
              : 'No distributed trace spans were returned for this request.'}
          </p>
        ) : (
          <div className="space-y-2">
            {orderedSpans.map(({ span: sp, depth, widthPct }) => (
              <div
                key={sp.span_id}
                data-testid={`trace-span-${sp.component}`}
                style={{ marginLeft: `${depth * 14}px` }}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/60 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-semibold text-indigo-700 dark:text-indigo-300 flex items-center gap-1 truncate">
                      <GitCommit className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      {sp.operation_name}
                    </span>
                    <span className="rounded bg-slate-200/70 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-300">
                      {sp.service_name}
                    </span>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <span className="font-mono font-semibold text-xs">
                      {(sp.duration_ns / 1e6).toFixed(2)} ms
                    </span>
                    <ObservationBadge kind={sp.observation_kind} />
                  </div>
                </div>

                {/* Proportional Span Duration Bar */}
                <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden mt-2">
                  <div
                    style={{ width: `${widthPct}%` }}
                    className="h-full bg-indigo-500 rounded-full"
                  />
                </div>

                {/* Progressive Disclosure for Span Metadata & Attributes */}
                <details className="disclosure-box mt-2 text-[11px] text-slate-500">
                  <summary className="text-[11px] font-mono text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                    span={sp.span_id} {sp.parent_span_id ? `← parent=${sp.parent_span_id}` : '(root)'} •{' '}
                    {Object.keys(sp.attributes || {}).length} attributes
                  </summary>
                  <pre className="mt-1.5 rounded bg-slate-100 dark:bg-slate-950 p-2 font-mono text-[11px] overflow-x-auto text-slate-800 dark:text-slate-200">
                    {JSON.stringify(sp.attributes, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
