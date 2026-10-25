.PHONY: setup run

FRONTEND_PORT ?= 4173
NATIVE_BINARY ?= .duplicate-check-cache/bin/duplicate-check-native

setup:
	@set -eu; \
	command -v python3 >/dev/null 2>&1 || { echo "python3 is required but was not found."; exit 1; }; \
	command -v go >/dev/null 2>&1 || { echo "Go is required but was not found."; exit 1; }; \
	test -d dist || { echo "dist directory is missing."; exit 1; }; \
	test -f dist/index.html || { echo "dist/index.html is missing."; exit 1; }; \
	mkdir -p "$(dir $(NATIVE_BINARY))"; \
	(cd native-scanner && go mod download); \
	go test ./native-scanner; \
	go build -o "$(NATIVE_BINARY)" ./native-scanner; \
	echo "Setup complete."; \
	echo "Native helper built at $(NATIVE_BINARY)";

run: setup
	@set -eu; \
	frontend_pid=; \
	backend_pid=; \
	cleanup() { \
		status=$$?; \
		if [ "$$status" -eq 130 ] || [ "$$status" -eq 143 ]; then status=0; fi; \
		trap - INT TERM EXIT; \
		if [ -n "$$frontend_pid" ] && kill -0 "$$frontend_pid" 2>/dev/null; then kill "$$frontend_pid" 2>/dev/null || true; fi; \
		if [ -n "$$backend_pid" ] && kill -0 "$$backend_pid" 2>/dev/null; then kill "$$backend_pid" 2>/dev/null || true; fi; \
		wait "$$frontend_pid" 2>/dev/null || true; \
		wait "$$backend_pid" 2>/dev/null || true; \
		exit $$status; \
	}; \
	trap cleanup INT TERM EXIT; \
	python3 -m http.server $(FRONTEND_PORT) --directory dist & frontend_pid=$$!; \
	"$(NATIVE_BINARY)" & backend_pid=$$!; \
	echo "Frontend: http://localhost:$(FRONTEND_PORT)"; \
	echo "Native scanner: http://127.0.0.1:4317"; \
	echo "Press Ctrl-C to stop both services."; \
	while kill -0 "$$frontend_pid" 2>/dev/null && kill -0 "$$backend_pid" 2>/dev/null; do sleep 1; done
