package redact

import (
	"strings"
	"testing"
)

func TestScrubStringAndPromptRedaction(t *testing.T) {
	raw := "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 hf_ABCDEFGHIJKLMN sk-1234567890abcdef"
	scrubbed := ScrubString(raw)
	if strings.Contains(scrubbed, "eyJhbGci") || strings.Contains(scrubbed, "hf_ABCDEF") || strings.Contains(scrubbed, "sk-12345") {
		t.Fatalf("expected secrets to be redacted, got %q", scrubbed)
	}

	summary := PromptSummary("Super secret user prompt content", true)
	preview, _ := summary["prompt_preview"].(string)
	if strings.Contains(preview, "Super secret") {
		t.Fatalf("expected raw prompt to be redacted when redactEnabled=true, got %q", preview)
	}

	attrs := SanitizeAttributes(map[string]any{
		"prompt":                     "raw prompt text",
		"prompt_tokens":              42,
		"prompt_tokens_source":       "vllm_usage",
		"completion_tokens_source":   "vllm_usage",
		"llm_d.prompt_tokens_source": "vllm_usage",
		"epp_token_backend":          "vllm",
		"authorization":              "Bearer secret12345",
		"selected_node":              "10.20.0.14:8000",
		"embedded_secret":            "token is hf_1234567890abcdef",
	}, true)

	if attrs["prompt"] != "[REDACTED]" {
		t.Fatalf("expected prompt key to be redacted, got %v", attrs["prompt"])
	}
	if attrs["prompt_tokens"] != 42 {
		t.Fatalf("expected prompt_tokens counter to be preserved, got %v", attrs["prompt_tokens"])
	}
	if attrs["prompt_tokens_source"] != "vllm_usage" || attrs["completion_tokens_source"] != "vllm_usage" || attrs["epp_token_backend"] != "vllm" {
		t.Fatalf("expected token provenance metadata to be preserved, got %+v", attrs)
	}
	if attrs["authorization"] != "[REDACTED]" {
		t.Fatalf("expected authorization key to be redacted, got %v", attrs["authorization"])
	}
	if strings.Contains(attrs["embedded_secret"].(string), "hf_12345") {
		t.Fatalf("expected embedded hf_ token to be scrubbed, got %v", attrs["embedded_secret"])
	}
}
