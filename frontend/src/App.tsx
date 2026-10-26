import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Terminal,
  Clock,
  Network,
  BarChart3,
  BookOpen,
  AlertOctagon,
  History,
} from 'lucide-react';
import {
  MetricsSummary,
  RequestRecord,
  ServerConfig,
} from './types/observatory';
import { ScreenPlayground } from './components/ScreenPlayground';
import { ScreenTimeline } from './components/ScreenTimeline';
import { ScreenTopology } from './components/ScreenTopology';
import { ScreenMetrics } from './components/ScreenMetrics';
import { ScreenLearningLab } from './components/ScreenLearningLab';
import { ObservationBadge } from './components/ObservationBadge';

type ActiveTab = 'playground' | 'timeline' | 'topology' | 'metrics' | 'learning';

const DEFAULT_CONFIG: ServerConfig = {
  version: 'v0.1.0',
  mock_mode: true,
  redact_prompts: true,
  allowed_models: ['Qwen/Qwen2.5-0.5B-Instruct'],
  default_model: 'Qwen/Qwen2.5-0.5B-Instruct',
  router_mode: 'optimized-baseline',
  max_output_tokens: 1024,
  cluster_name: 'llm-d-observatory',
  namespace: 'llm-d-observatory',
  upstream_url: 'http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:80',
  router_modes: ['optimized-baseline', 'precise-prefix-cache', 'flow-control'],
  priority_bands: ['premium-traffic', 'standard-traffic', 'best-effort-traffic'],
  mock_scenarios: [
    'success',
    'delay',
    'saturated',
    'cancel',
    'partial_trace',
    'delayed_trace',
    'missing_metrics',
  ],
};

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('playground');
  const [config, setConfig] = useState<ServerConfig>(DEFAULT_CONFIG);
  const [prompt, setPrompt] = useState<string>(
    'Explain how the llm-d Endpoint Picker (EPP) filters and scores CPU model server replicas.',
  );
  const [model, setModel] = useState<string>(DEFAULT_CONFIG.default_model);
  const [routerMode, setRouterMode] = useState<string>(DEFAULT_CONFIG.router_mode);
  const [priorityBand, setPriorityBand] = useState<string>('standard-traffic');
  const [temperature, setTemperature] = useState<number>(0.2);
  const [maxTokens, setMaxTokens] = useState<number>(32);
  const [stream, setStream] = useState<boolean>(true);
  const [scenario, setScenario] = useState<string>('success');

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [outputText, setOutputText] = useState<string>('');
  const [errorText, setErrorText] = useState<string>('');
  const [activeRecord, setActiveRecord] = useState<RequestRecord | null>(null);
  const [recentRequests, setRecentRequests] = useState<RequestRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/metrics');
      if (res.ok) {
        const data: MetricsSummary = await res.json();
        setMetrics(data);
      }
    } catch {
      // Ignored during offline unit tests
    }
  }, []);

  const fetchRequestDetail = useCallback(async (reqId: string) => {
    if (!reqId) return null;
    try {
      const res = await fetch(`/api/requests/${reqId}`);
      if (res.ok) {
        const rec: RequestRecord = await res.json();
        setActiveRecord(rec);
        return rec;
      }
    } catch {
      // Ignored
    }
    return null;
  }, []);

  const fetchRecentRequests = useCallback(async () => {
    try {
      const res = await fetch('/api/requests');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.requests)) {
          setRecentRequests(data.requests);
        }
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const cfgRes = await fetch('/api/config');
        if (cfgRes.ok && mounted) {
          const cfgData: ServerConfig = await cfgRes.json();
          setConfig(cfgData);
          setModel(cfgData.default_model);
          setRouterMode(cfgData.router_mode);
        }
      } catch {
        // Keep DEFAULT_CONFIG
      }
      if (mounted) {
        await fetchMetrics();
        await fetchRecentRequests();
      }
    })();
    return () => {
      mounted = false;
    };
  }, [fetchMetrics, fetchRecentRequests]);

  const handleSend = useCallback(async () => {
    if (!prompt.trim() || isRunning) return;

    setIsRunning(true);
    setOutputText('');
    setErrorText('');

    const abortController = new AbortController();
    abortRef.current = abortController;

    const endpoint = stream ? '/api/infer/stream' : '/api/infer';
    let currentReqId = '';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          temperature,
          max_tokens: maxTokens,
          stream,
          router_mode: routerMode,
          priority_band: priorityBand,
          scenario: config.mock_mode ? scenario : undefined,
        }),
        signal: abortController.signal,
      });

      currentReqId = res.headers.get('X-Request-Id') || '';
      if (currentReqId) {
        void fetchRequestDetail(currentReqId);
      }

      if (!res.ok) {
        const rawErr = await res.text();
        setErrorText(`HTTP ${res.status}: ${rawErr}`);
        if (currentReqId) {
          await fetchRequestDetail(currentReqId);
        }
        await fetchMetrics();
        await fetchRecentRequests();
        setIsRunning(false);
        return;
      }

      if (!stream) {
        const json = await res.json();
        const text = json?.choices?.[0]?.message?.content || '';
        setOutputText(text);
      } else if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              if (parsed.error) {
                setErrorText(parsed.error.message || 'Upstream stream error');
              }
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                setOutputText((prev) => prev + delta);
              }
            } catch {
              // Ignore partial line
            }
          }
          if (currentReqId) {
            void fetchRequestDetail(currentReqId);
          }
        }
      }

      if (currentReqId) {
        const rec = await fetchRequestDetail(currentReqId);
        // If trace enrichment is asynchronous (e.g., delayed_trace scenario or live Jaeger flush), poll once more after 450ms
        if (rec && rec.trace.status === 'pending') {
          setTimeout(() => {
            void fetchRequestDetail(currentReqId);
          }, 450);
        }
      }
      await fetchMetrics();
      await fetchRecentRequests();
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setErrorText('Request cancelled by user.');
      } else {
        setErrorText(err?.message || 'Request failed');
      }
      if (currentReqId) {
        setTimeout(() => {
          void fetchRequestDetail(currentReqId);
          void fetchMetrics();
          void fetchRecentRequests();
        }, 80);
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [
    prompt,
    isRunning,
    stream,
    model,
    temperature,
    maxTokens,
    routerMode,
    priorityBand,
    config.mock_mode,
    scenario,
    fetchRequestDetail,
    fetchMetrics,
    fetchRecentRequests,
  ]);

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const handleClear = useCallback(() => {
    setOutputText('');
    setErrorText('');
    setActiveRecord(null);
  }, []);

  const tabs: Array<{ id: ActiveTab; label: string; icon: React.ReactNode }> = [
    { id: 'playground', label: 'Inference Playground', icon: <Terminal className="w-4 h-4" /> },
    { id: 'timeline', label: 'Live Lifecycle Timeline', icon: <Clock className="w-4 h-4" /> },
    { id: 'topology', label: 'Interactive Topology', icon: <Network className="w-4 h-4" /> },
    { id: 'metrics', label: 'Metrics', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'learning', label: 'Learning Lab', icon: <BookOpen className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Visible Mock Mode Banner when active */}
      {config.mock_mode && (
        <div
          role="status"
          data-testid="mock-mode-banner"
          className="bg-amber-500/20 border-b border-amber-500/40 px-4 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
            <AlertOctagon className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              <strong>LOCAL DEMO / MOCK MODE ACTIVE (OBSERVER_MOCK_MODE=true):</strong> All upstream events, timings, and spans are generated by deterministic local fixtures and explicitly marked <code className="font-mono font-bold">simulated</code>. No Google Cloud or live GKE resources are queried.
            </span>
          </div>
          <ObservationBadge kind="simulated" />
        </div>
      )}

      {/* Top Application Header */}
      <header className="border-b border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-sky-600 text-white flex items-center justify-center font-bold">
              <Activity className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">llm-d Inference Observatory</h1>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Interactive CPU-Only GKE Inference Lifecycle, Endpoint Picker Routing & OpenTelemetry Lab
              </p>
            </div>
          </div>

          {/* Request Selector Dropdown & Stack Pill */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {recentRequests.length > 0 && (
              <div className="flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <label htmlFor="request-history-select" className="sr-only">
                  Select Observed Request
                </label>
                <select
                  id="request-history-select"
                  data-testid="request-history-select"
                  value={activeRecord?.request_id || ''}
                  onChange={(e) => void fetchRequestDetail(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 font-mono text-xs"
                >
                  {recentRequests.map((r) => (
                    <option key={r.request_id} value={r.request_id}>
                      {r.request_id} ({r.status} - {r.scenario || r.router_mode})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <span className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 font-mono">
              llm-d v1.0.0 | GAIE v1.6.2 | vLLM CPU v0.31.0
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav
          aria-label="Observatory Screens"
          className="max-w-7xl mx-auto mt-4 flex flex-wrap gap-1.5 border-t border-slate-200 dark:border-slate-800 pt-3"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              data-testid={`nav-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-6">
        {activeTab === 'playground' && (
          <ScreenPlayground
            config={config}
            prompt={prompt}
            setPrompt={setPrompt}
            model={model}
            setModel={setModel}
            routerMode={routerMode}
            setRouterMode={setRouterMode}
            priorityBand={priorityBand}
            setPriorityBand={setPriorityBand}
            temperature={temperature}
            setTemperature={setTemperature}
            maxTokens={maxTokens}
            setMaxTokens={setMaxTokens}
            stream={stream}
            setStream={setStream}
            scenario={scenario}
            setScenario={setScenario}
            isRunning={isRunning}
            outputText={outputText}
            errorText={errorText}
            activeRecord={activeRecord}
            onSend={() => void handleSend()}
            onCancel={handleCancel}
            onClear={handleClear}
            onRetry={() => void handleSend()}
          />
        )}

        {activeTab === 'timeline' && <ScreenTimeline record={activeRecord} />}

        {activeTab === 'topology' && (
          <ScreenTopology record={activeRecord} mockMode={config.mock_mode} />
        )}

        {activeTab === 'metrics' && (
          <ScreenMetrics
            metrics={metrics}
            activeRecord={activeRecord}
            onRefresh={() => void fetchMetrics()}
          />
        )}

        {activeTab === 'learning' && <ScreenLearningLab />}
      </main>
    </div>
  );
};
