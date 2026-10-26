.PHONY: help preflight dev test test-go test-frontend test-e2e lint \
	tf-fmt tf-init tf-validate tf-plan \
	render-manifests validate-manifests \
	docker-build compose-smoke benchmark-mock verify-all

help: ## Show available Make targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

preflight: ## Run read-only local and cloud preflight verification
	@./scripts/preflight.sh

dev: ## Start local demo mode (Observer API with OBSERVER_MOCK_MODE=true + Vite UI)
	@echo "Starting Observer API (mock mode on :8080) and React Frontend (:5173)..."
	@trap 'kill 0' INT TERM; \
	(cd backend/observer && OBSERVER_MOCK_MODE=true go run ./cmd/observer) & \
	(cd frontend && pnpm dev) & \
	wait

test-go: ## Run Go formatting check, go vet, and race-enabled unit tests
	cd backend/observer && test -z "$$(gofmt -l .)" && go vet ./... && go test -v -race ./...

test-frontend: ## Run TypeScript typecheck, ESLint, and Vitest unit tests
	cd frontend && pnpm typecheck && pnpm lint && pnpm test

test-e2e: ## Run Playwright end-to-end browser tests against local mock mode
	cd frontend && pnpm test:e2e

test: test-go test-frontend test-e2e ## Run all unit, component, and E2E tests

tf-fmt: ## Check Terraform formatting
	cd terraform && terraform fmt -check

tf-init: ## Initialize Terraform providers locally
	cd terraform && terraform init -input=false

tf-validate: tf-init ## Validate Terraform configuration
	cd terraform && terraform validate

tf-plan: tf-init ## Generate a read-only Terraform execution plan (never applies)
	./scripts/tf-plan.sh

render-manifests: ## Render llm-d Router Helm templates and Kubernetes manifests locally
	./scripts/render-manifests.sh

validate-manifests: render-manifests ## Validate all Kubernetes manifests and rendered Helm output
	./scripts/validate-manifests.sh

docker-build: ## Build Observer API and Frontend container images locally (no push)
	./scripts/build-images.sh

compose-smoke: ## Run local Docker Compose smoke test and verify endpoints
	./scripts/smoke-test.sh --local-compose

benchmark-mock: ## Run reproducible benchmark harness against in-process mock fixture server
	mkdir -p artifacts/test-results
	cd backend/observer && go run ./cmd/benchmark \
		--in-process-mock=true \
		--environment=mock \
		--scenario=success \
		--warmup=1 \
		--requests=4 \
		--concurrency=2 \
		--json-out=../../artifacts/test-results/benchmark-mock-report.json \
		--csv-out=../../artifacts/test-results/benchmark-mock-samples.csv

verify-all: test tf-fmt tf-validate validate-manifests benchmark-mock ## Run full local verification suite
