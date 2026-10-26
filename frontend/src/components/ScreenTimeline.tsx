import React, { useMemo } from 'react';
import { Clock, GitCommit, AlertCircle, CheckCircle2, Layers } from 'lucide-react';
import { EventEnvelope, RequestRecord, STAGE_EXPLANATIONS } from '../types/observatory';
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
  const sortedEvents = useMemo(() => {
    if (!record) return [];
    return sortLifecycleEvents(record.events);
  }, [record]);

  if (!record) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-sm text-slate-500">
        No request selected. Submit a prompt in the <strong>Inference Playground</strong> to inspect the live lifecycle timeline and correlated OpenTelemetry spans.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header & Trace Enrichment Banner */}
      <section
        aria-label="Request Lifecycle Summary"
        className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
              Live Request Lifecycle Timeline ({sortedEvents.length} events)
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Events are ordered deterministically by sequence and correlated via Request ID{' '}
              <code className="font-mono font-semibold">{record.request_id}</code> and W3C Trace ID{' '}
              <code className="font-mono font-semibold">{record.trace_id}</code>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="trace-enrichment-status"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-mono"
            >
              Trace Status: <strong>{record.trace.status}</strong>
            </span>
            <ObservationBadge kind={record.trace.observation_kind} />
          </div>
        </div>

        {/* Prefill Observability Honesty Note */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between font-semibold mb-1">
              <span>HTTP Headers Arrival</span>
              <ObservationBadge kind={record.timings.upstream_headers_ms.observation_kind} />
            </div>
            <div className="font-mono text-sm font-bold">
              {record.timings.upstream_headers_ms.value !== null
                ? `${record.timings.upstream_headers_ms.value} ms`
                : 'Unavailable'}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{record.timings.upstream_headers_ms.explanation}</p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between font-semibold mb-1">
              <span>True TTFT (First Content Token)</span>
              <ObservationBadge kind={record.timings.ttft_ms.observation_kind} />
            </div>
            <div className="font-mono text-sm font-bold">
              {record.timings.ttft_ms.value !== null ? `${record.timings.ttft_ms.value} ms` : 'Unavailable'}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{record.timings.ttft_ms.explanation}</p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between font-semibold mb-1">
              <span>Model-Server Prefill Span</span>
              <ObservationBadge kind={record.timings.prefill_duration_ms.observation_kind} />
            </div>
            <div data-testid="prefill-duration-value" className="font-mono text-sm font-bold">
              {record.timings.prefill_duration_ms.value !== null
                ? `${record.timings.prefill_duration_ms.value} ms`
                : 'Unavailable'}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{record.timings.prefill_duration_ms.explanation}</p>
          </div>
        </div>
      </section>

      {/* Responsive Accessible Lifecycle Table (modern-web-guidance: responsive-table) */}
      <section className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby="lifecycle-table-caption"
          className="table-wrapper rounded-lg border border-slate-200 dark:border-slate-800"
        >
          <table className="lifecycle-table text-left text-xs">
            <caption id="lifecycle-table-caption" className="sr-only">
              Chronological inference lifecycle events and observation classifications for request {record.request_id}
            </caption>
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                <th scope="col" className="p-3 font-semibold">
                  # / Stage Event
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Source Component
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
                  Technical Explanation & Observed Attributes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {sortedEvents.map((ev) => {
                const durMs = ev.duration_ns !== null ? (ev.duration_ns / 1e6).toFixed(2) + ' ms' : '—';
                const stageDesc = STAGE_EXPLANATIONS[ev.event_type] || 'Correlated lifecycle event.';
                const isFailure = ev.event_type === 'request.failed' || ev.event_type === 'request.cancelled';

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
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
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
                      <div className="text-[11px] text-slate-500 mt-0.5">src: {ev.source}</div>
                    </td>
                    <td className="p-3 font-mono text-[11px] text-slate-600 dark:text-slate-400 whitespace-nowrap align-top">
                      {ev.source_timestamp.split('T')[1] || ev.source_timestamp}
                    </td>
                    <td className="p-3 font-mono font-semibold whitespace-nowrap align-top">{durMs}</td>
                    <td className="p-3 align-top">
                      <ObservationBadge kind={ev.observation_kind} />
                    </td>
                    <td className="p-3 align-top max-w-xl">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{ev.message}</div>
                      <p className="text-[11px] text-slate-500 mt-1">{stageDesc}</p>
                      {Object.keys(ev.attributes || {}).length > 0 && (
                        <pre className="mt-1.5 rounded bg-slate-100 dark:bg-slate-950 p-2 font-mono text-[11px] overflow-x-auto">
                          {JSON.stringify(ev.attributes, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Correlated Distributed OpenTelemetry Trace Spans */}
      <section
        aria-label="Correlated OpenTelemetry Trace Spans"
        className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold">
              Correlated Distributed Trace Spans ({record.trace.spans.length})
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

        {record.trace.spans.length === 0 ? (
          <p className="text-xs text-slate-500">
            {record.trace.status === 'pending'
              ? 'Waiting for asynchronous OpenTelemetry span flush from Collector / Jaeger...'
              : 'No distributed trace spans were returned for this request.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {record.trace.spans.map((sp) => (
              <div
                key={sp.span_id}
                data-testid={`trace-span-${sp.component}`}
                className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-mono font-semibold text-indigo-700 dark:text-indigo-300 flex items-center gap-1">
                    <GitCommit className="w-3.5 h-3.5" aria-hidden="true" />
                    {sp.operation_name}
                  </span>
                  <ObservationBadge kind={sp.observation_kind} />
                </div>
                <div className="text-[11px] text-slate-500 font-mono mb-2">
                  svc={sp.service_name} | span={sp.span_id} {sp.parent_span_id ? `<- parent=${sp.parent_span_id}` : '(root)'} |{' '}
                  {(sp.duration_ns / 1e6).toFixed(2)} ms
                </div>
                <pre className="rounded bg-slate-100 dark:bg-slate-950 p-2 font-mono text-[11px] overflow-x-auto">
                  {JSON.stringify(sp.attributes, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
