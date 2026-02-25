BINARY     := gateway
MODULE     := github.com/tractorfm/chatcode/packages/gateway
VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS    := -ldflags "-X main.Version=$(VERSION) -X main.BuildTime=$(BUILD_TIME) -s -w"

.PHONY: build build-linux build-linux-arm64 build-darwin-arm64 release test lint clean mock-cp tidy

build:
	go build $(LDFLAGS) -o $(BINARY) ./cmd/gateway

build-linux:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
		go build $(LDFLAGS) -o $(BINARY)-linux-amd64 ./cmd/gateway

build-linux-arm64:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
		go build $(LDFLAGS) -o $(BINARY)-linux-arm64 ./cmd/gateway

build-darwin-arm64:
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
		go build $(LDFLAGS) -o $(BINARY)-darwin-arm64 ./cmd/gateway

release:
	@test -n "$(RELEASE_VERSION)" || (echo "set RELEASE_VERSION=vX.Y.Z"; exit 1)
	./scripts/build-release.sh "$(RELEASE_VERSION)"

test:
	go test ./... -v -count=1 -timeout 120s

lint:
	@which golangci-lint > /dev/null || (echo "install golangci-lint first: https://golangci-lint.run/usage/install/" && exit 1)
	golangci-lint run ./...

mock-cp:
	go run ./cmd/mockcp

tidy:
	go mod tidy

clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64 $(BINARY)-linux-arm64 $(BINARY)-darwin-arm64 $(BINARY).new $(BINARY).prev
