# syntax=docker/dockerfile:1
FROM golang:1.24-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/observer ./cmd/observer && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/benchmark ./cmd/benchmark

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=builder /out/observer /app/observer
COPY --from=builder /out/benchmark /app/benchmark

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/observer"]
