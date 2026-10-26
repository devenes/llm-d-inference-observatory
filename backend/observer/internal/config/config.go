package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Version is injected at build time or defaults to v0.1.0.
var Version = "v0.1.0"

// Config holds validated runtime configuration for the Observer API.
type Config struct {
	ListenAddr           string        `json:"listen_addr"`
	UpstreamURL          string        `json:"upstream_url"`
	AllowedUpstreamHosts []string      `json:"allowed_upstream_hosts"`
	AllowedModels        []string      `json:"allowed_models"`
	DefaultModel         string        `json:"default_model"`
	RouterMode           string        `json:"router_mode"`
	MockMode             bool          `json:"mock_mode"`
	RedactPrompts        bool          `json:"redact_prompts"`
	MaxRequestBodyBytes  int64         `json:"max_request_body_bytes"`
	MaxOutputTokens      int           `json:"max_output_tokens"`
	MaxConcurrentReqs    int           `json:"max_concurrent_requests"`
	RequestTimeout       time.Duration `json:"request_timeout"`
	TraceQueryTimeout    time.Duration `json:"trace_query_timeout"`
	MaxRetainedRequests  int           `json:"max_retained_requests"`
	CORSAllowedOrigins   []string      `json:"cors_allowed_origins"`
	OTLPEndpoint         string        `json:"otlp_endpoint"`
	JaegerQueryURL       string        `json:"jaeger_query_url"`
	EPPMetricsURL        string        `json:"epp_metrics_url"`
	EPPBearerToken       string        `json:"-"`
	VLLMMetricsURL       string        `json:"vllm_metrics_url"`
	ClusterName          string        `json:"cluster_name"`
	Namespace            string        `json:"namespace"`
}

// Default returns safe, minimal-cost defaults aligned with the validated CPU GKE reference stack.
func Default() Config {
	return Config{
		ListenAddr:  ":8080",
		UpstreamURL: "http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:80",
		AllowedUpstreamHosts: []string{
			"localhost",
			"127.0.0.1",
			"llm-d-router-epp",
			"llm-d-router-epp.llm-d-observatory.svc.cluster.local",
			"llm-d-router-epp.llm-d-cpu-lab.svc.cluster.local",
			"mock-llm-d",
		},
		AllowedModels: []string{
			"Qwen/Qwen2.5-0.5B-Instruct",
		},
		DefaultModel:        "Qwen/Qwen2.5-0.5B-Instruct",
		RouterMode:          "optimized-baseline",
		MockMode:            false,
		RedactPrompts:       true,
		MaxRequestBodyBytes: 64 * 1024, // 64 KiB
		MaxOutputTokens:     1024,
		MaxConcurrentReqs:   16,
		RequestTimeout:      120 * time.Second,
		TraceQueryTimeout:   4 * time.Second,
		MaxRetainedRequests: 200,
		CORSAllowedOrigins: []string{
			"http://localhost:5173",
			"http://127.0.0.1:5173",
			"http://localhost:4173",
			"http://127.0.0.1:4173",
			"http://localhost:3000",
			"http://localhost:8080",
		},
		OTLPEndpoint:   "",
		JaegerQueryURL: "http://jaeger-query.llm-d-observatory.svc.cluster.local:16686",
		EPPMetricsURL:  "http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:9090/metrics",
		VLLMMetricsURL: "http://llm-d-router-epp-model-servers.llm-d-observatory.svc.cluster.local:8000/metrics",
		ClusterName:    "llm-d-observatory",
		Namespace:      "llm-d-observatory",
	}
}

// LoadFromEnv loads configuration from environment variables and validates security boundaries.
func LoadFromEnv() (Config, error) {
	cfg := Default()

	if v := strings.TrimSpace(os.Getenv("OBSERVER_LISTEN_ADDR")); v != "" {
		cfg.ListenAddr = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_UPSTREAM_URL")); v != "" {
		cfg.UpstreamURL = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_ALLOWED_UPSTREAM_HOSTS")); v != "" {
		cfg.AllowedUpstreamHosts = splitCSV(v)
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_ALLOWED_MODELS")); v != "" {
		cfg.AllowedModels = splitCSV(v)
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_DEFAULT_MODEL")); v != "" {
		cfg.DefaultModel = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_ROUTER_MODE")); v != "" {
		cfg.RouterMode = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_MOCK_MODE")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return cfg, fmt.Errorf("invalid OBSERVER_MOCK_MODE %q: %w", v, err)
		}
		cfg.MockMode = b
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_REDACT_PROMPTS")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return cfg, fmt.Errorf("invalid OBSERVER_REDACT_PROMPTS %q: %w", v, err)
		}
		cfg.RedactPrompts = b
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_MAX_BODY_BYTES")); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("invalid OBSERVER_MAX_BODY_BYTES %q", v)
		}
		cfg.MaxRequestBodyBytes = n
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_MAX_OUTPUT_TOKENS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("invalid OBSERVER_MAX_OUTPUT_TOKENS %q", v)
		}
		cfg.MaxOutputTokens = n
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_MAX_CONCURRENT_REQUESTS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("invalid OBSERVER_MAX_CONCURRENT_REQUESTS %q", v)
		}
		cfg.MaxConcurrentReqs = n
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_REQUEST_TIMEOUT")); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return cfg, fmt.Errorf("invalid OBSERVER_REQUEST_TIMEOUT %q", v)
		}
		cfg.RequestTimeout = d
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_TRACE_QUERY_TIMEOUT")); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return cfg, fmt.Errorf("invalid OBSERVER_TRACE_QUERY_TIMEOUT %q", v)
		}
		cfg.TraceQueryTimeout = d
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_MAX_RETAINED_REQUESTS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("invalid OBSERVER_MAX_RETAINED_REQUESTS %q", v)
		}
		cfg.MaxRetainedRequests = n
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_CORS_ALLOWED_ORIGINS")); v != "" {
		cfg.CORSAllowedOrigins = splitCSV(v)
	}
	if v := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")); v != "" {
		cfg.OTLPEndpoint = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_JAEGER_QUERY_URL")); v != "" {
		cfg.JaegerQueryURL = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_EPP_METRICS_URL")); v != "" {
		cfg.EPPMetricsURL = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_EPP_BEARER_TOKEN")); v != "" {
		cfg.EPPBearerToken = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_VLLM_METRICS_URL")); v != "" {
		cfg.VLLMMetricsURL = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_CLUSTER_NAME")); v != "" {
		cfg.ClusterName = v
	}
	if v := strings.TrimSpace(os.Getenv("OBSERVER_NAMESPACE")); v != "" {
		cfg.Namespace = v
	}

	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// Validate enforces upstream allowlist and operational constraints.
func (c Config) Validate() error {
	if err := c.ValidateUpstreamURL(c.UpstreamURL); err != nil {
		return err
	}
	if len(c.AllowedModels) == 0 {
		return fmt.Errorf("allowed_models must not be empty")
	}
	if c.MaxRequestBodyBytes <= 0 || c.MaxRequestBodyBytes > 10*1024*1024 {
		return fmt.Errorf("max_request_body_bytes out of safe bounds: %d", c.MaxRequestBodyBytes)
	}
	if c.MaxOutputTokens <= 0 || c.MaxOutputTokens > 8192 {
		return fmt.Errorf("max_output_tokens out of safe bounds: %d", c.MaxOutputTokens)
	}
	if c.MaxConcurrentReqs <= 0 || c.MaxConcurrentReqs > 512 {
		return fmt.Errorf("max_concurrent_requests out of safe bounds: %d", c.MaxConcurrentReqs)
	}
	return nil
}

// ValidateUpstreamURL ensures the target URL uses http/https and its hostname is in AllowedUpstreamHosts.
func (c Config) ValidateUpstreamURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid upstream URL %q: %w", rawURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported upstream URL scheme %q (must be http or https)", u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return fmt.Errorf("upstream URL %q missing hostname", rawURL)
	}
	for _, allowed := range c.AllowedUpstreamHosts {
		if strings.ToLower(strings.TrimSpace(allowed)) == host {
			return nil
		}
	}
	return fmt.Errorf("upstream host %q is not in allowlist %v", host, c.AllowedUpstreamHosts)
}

// IsModelAllowed checks whether the requested model identifier is permitted.
func (c Config) IsModelAllowed(model string) bool {
	for _, m := range c.AllowedModels {
		if m == model {
			return true
		}
	}
	return false
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
