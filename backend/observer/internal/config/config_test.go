package config

import (
	"testing"
)

func TestValidateUpstreamURLAllowlist(t *testing.T) {
	cfg := Default()

	validURLs := []string{
		"http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:80",
		"http://localhost:8081/v1/chat/completions",
		"https://127.0.0.1:8000",
	}
	for _, u := range validURLs {
		if err := cfg.ValidateUpstreamURL(u); err != nil {
			t.Fatalf("expected URL %q to be allowed, got error: %v", u, err)
		}
	}

	invalidURLs := []string{
		"http://evil.example.com:8080",
		"http://169.254.169.254/computeMetadata/v1/",
		"file:///etc/passwd",
		"ftp://localhost:21",
	}
	for _, u := range invalidURLs {
		if err := cfg.ValidateUpstreamURL(u); err == nil {
			t.Fatalf("expected URL %q to be rejected by allowlist", u)
		}
	}
}

func TestIsModelAllowed(t *testing.T) {
	cfg := Default()
	if !cfg.IsModelAllowed("Qwen/Qwen2.5-0.5B-Instruct") {
		t.Fatal("expected default CPU model to be allowed")
	}
	if cfg.IsModelAllowed("arbitrary/untrusted-model") {
		t.Fatal("expected untrusted model to be rejected")
	}
}
