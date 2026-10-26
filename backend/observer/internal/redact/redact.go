package redact

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

var (
	bearerRegex    = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9\-._~+/]+=*`)
	hfTokenRegex   = regexp.MustCompile(`\bhf_[A-Za-z0-9]{10,}\b`)
	skTokenRegex   = regexp.MustCompile(`\bsk-[A-Za-z0-9\-_]{10,}\b`)
	apiKeyKeyWords = []string{
		"authorization",
		"api_key",
		"apikey",
		"token",
		"secret",
		"password",
		"credential",
		"prompt",
		"messages",
		"completion",
		"content",
	}
)

// ScrubString removes bearer tokens, HuggingFace tokens, and OpenAI-style secret keys from strings.
func ScrubString(in string) string {
	if in == "" {
		return ""
	}
	out := bearerRegex.ReplaceAllString(in, "Bearer [REDACTED]")
	out = hfTokenRegex.ReplaceAllString(out, "hf_[REDACTED]")
	out = skTokenRegex.ReplaceAllString(out, "sk-[REDACTED]")
	return out
}

// PromptSummary produces a safe, deterministic metadata summary of a prompt without storing raw text when redactEnabled is true.
func PromptSummary(prompt string, redactEnabled bool) map[string]any {
	sum := sha256.Sum256([]byte(prompt))
	shortHash := hex.EncodeToString(sum[:8])
	charCount := len([]rune(prompt))
	approxTokens := EstimateTokens(prompt)

	res := map[string]any{
		"prompt_sha256_prefix": shortHash,
		"prompt_chars":         charCount,
		"estimated_tokens":     approxTokens,
		"redacted":             redactEnabled,
	}
	if !redactEnabled {
		res["prompt_preview"] = ScrubString(truncateRunes(prompt, 120))
	} else {
		res["prompt_preview"] = fmt.Sprintf("[REDACTED %d chars, sha256:%s]", charCount, shortHash)
	}
	return res
}

// SanitizeAttributes filters a map of event or span attributes, removing or redacting sensitive keys and values.
func SanitizeAttributes(attrs map[string]any, redactPrompts bool) map[string]any {
	if len(attrs) == 0 {
		return map[string]any{}
	}
	clean := make(map[string]any, len(attrs))
	for k, v := range attrs {
		lowerKey := strings.ToLower(k)
		if isSensitiveKey(lowerKey, redactPrompts) {
			clean[k] = "[REDACTED]"
			continue
		}
		switch typed := v.(type) {
		case string:
			clean[k] = ScrubString(typed)
		default:
			clean[k] = v
		}
	}
	return clean
}

func isSensitiveKey(lowerKey string, redactPrompts bool) bool {
	// Never redact numeric LLM token counters, provenance sources, indices, hashes, content types, or EPP tokenizer/scorer metadata.
	if strings.HasSuffix(lowerKey, "_tokens") ||
		strings.HasSuffix(lowerKey, "_tokens_source") ||
		strings.HasSuffix(lowerKey, "_token_backend") ||
		strings.HasSuffix(lowerKey, "_token_count") ||
		strings.HasPrefix(lowerKey, "token_") ||
		strings.HasPrefix(lowerKey, "tokens_") ||
		strings.Contains(lowerKey, "token_producer") ||
		strings.Contains(lowerKey, "token-load") ||
		strings.HasSuffix(lowerKey, "_chars") ||
		strings.HasSuffix(lowerKey, "_prefix") ||
		strings.HasSuffix(lowerKey, "_sha256") ||
		strings.HasSuffix(lowerKey, "_count") ||
		lowerKey == "content_type" ||
		lowerKey == "content-type" ||
		lowerKey == "content_length" {
		return false
	}

	for _, kw := range apiKeyKeyWords {
		if kw == "prompt" || kw == "messages" || kw == "completion" || kw == "content" {
			if !redactPrompts {
				continue
			}
		}
		if strings.Contains(lowerKey, kw) {
			return true
		}
	}
	return false
}

// EstimateTokens provides a lightweight deterministic heuristic (~4 chars/token) when tokenizer counts are not yet returned.
func EstimateTokens(text string) int {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0
	}
	n := (len([]rune(trimmed)) + 3) / 4
	if n < 1 {
		return 1
	}
	return n
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "..."
}
