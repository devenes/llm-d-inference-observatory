package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/server"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg, err := config.LoadFromEnv()
	if err != nil {
		logger.Error("failed to load configuration", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	tracer, err := telemetry.NewTracerManager(ctx, cfg)
	if err != nil {
		logger.Error("failed to initialize OpenTelemetry tracer", "error", err)
		os.Exit(1)
	}

	hub := events.NewHub(cfg.MaxRetainedRequests, cfg.RedactPrompts)
	metrics := telemetry.NewMetricsCollector(cfg)
	srv := server.New(cfg, logger, hub, tracer, metrics)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting llm-d Observer API server",
			"listen_addr", cfg.ListenAddr,
			"mock_mode", cfg.MockMode,
			"upstream_url", cfg.UpstreamURL,
			"router_mode", cfg.RouterMode,
			"redact_prompts", cfg.RedactPrompts,
		)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down Observer API server gracefully")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", "error", err)
	}
	if err := tracer.Shutdown(shutdownCtx); err != nil {
		logger.Error("tracer shutdown error", "error", err)
	}
	logger.Info("Observer API shutdown complete")
}
