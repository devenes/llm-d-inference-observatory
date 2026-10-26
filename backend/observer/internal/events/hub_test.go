package events

import (
	"testing"
	"time"
)

func TestHubOrderingCorrelationAndPrefillNeverInferredFromTTFT(t *testing.T) {
	hub := NewHub(3, true)
	t0 := time.Now().UTC()

	hub.CreateRequest("req_1", "trace_1", "Qwen/Qwen2.5-0.5B-Instruct", "optimized-baseline", "standard-traffic", true, false, "", map[string]any{"prompt_chars": 20}, t0)

	snapshot, ch, unsub, ok := hub.Subscribe("req_1")
	if !ok || len(snapshot) != 0 {
		t.Fatalf("expected clean initial subscription")
	}
	defer unsub()

	e1, _ := hub.Emit("req_1", EventRequestAccepted, "observer-api", "observer-api", "Accepted", ObservationObserved, nil, nil)
	e2, _ := hub.Emit("req_1", EventGatewayForwarded, "observer-api", "gateway-proxy", "Forwarded", ObservationObserved, nil, nil)
	e3, _ := hub.Emit("req_1", EventModelFirstToken, "observer-api", "model-server", "First token", ObservationMeasured, nil, nil)

	if e1.Sequence != 1 || e2.Sequence != 2 || e3.Sequence != 3 {
		t.Fatalf("unexpected sequence numbers: %d, %d, %d", e1.Sequence, e2.Sequence, e3.Sequence)
	}

	got1 := <-ch
	if got1.EventID != e1.EventID || got1.TraceID != "trace_1" {
		t.Fatalf("SSE subscriber did not receive correlated event")
	}

	// Verify FinalizeTimings never infers PrefillDurationMs from TTFT alone when prefillSpanMs == nil.
	headersDur := 35 * time.Millisecond
	ttftDur := 120 * time.Millisecond
	totalDur := 250 * time.Millisecond
	hub.UpdateRequest("req_1", func(rec *RequestRecord) {
		FinalizeTimings(rec, &headersDur, &ttftDur, &totalDur, []float64{20.0, 25.0, 30.0}, 12, 4, nil)
	})

	rec, exists := hub.GetRequest("req_1")
	if !exists {
		t.Fatal("expected request record")
	}
	if rec.Timings.TTFTMs.ObservationKind != ObservationMeasured || rec.Timings.TTFTMs.Value == nil {
		t.Fatalf("expected TTFTMs to be measured, got %+v", rec.Timings.TTFTMs)
	}
	if rec.Timings.PrefillDurationMs.ObservationKind != ObservationUnavailable || rec.Timings.PrefillDurationMs.Value != nil {
		t.Fatalf("PrefillDurationMs must remain unavailable when no explicit prefill span exists, got %+v", rec.Timings.PrefillDurationMs)
	}
	if rec.Timings.MeanITLMs.ObservationKind != ObservationDerived || rec.Timings.MeanITLMs.Value == nil {
		t.Fatalf("expected MeanITLMs to be derived, got %+v", rec.Timings.MeanITLMs)
	}

	// Verify bounded eviction (capacity = 3)
	hub.CreateRequest("req_2", "t2", "Qwen/Qwen2.5-0.5B-Instruct", "optimized-baseline", "standard-traffic", true, false, "", nil, t0)
	hub.CreateRequest("req_3", "t3", "Qwen/Qwen2.5-0.5B-Instruct", "optimized-baseline", "standard-traffic", true, false, "", nil, t0)
	hub.CreateRequest("req_4", "t4", "Qwen/Qwen2.5-0.5B-Instruct", "optimized-baseline", "standard-traffic", true, false, "", nil, t0)

	if _, ok := hub.GetRequest("req_1"); ok {
		t.Fatal("expected oldest request req_1 to be evicted when capacity 3 exceeded")
	}
}
