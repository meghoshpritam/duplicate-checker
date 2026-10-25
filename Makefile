.PHONY: run

FRONTEND_PORT ?= 4173

run:
	@set -eu; \
	frontend_pid=; \
	backend_pid=; \
	cleanup() { \
		status=$$?; \
		trap - INT TERM EXIT; \
		if [ -n "$$frontend_pid" ] && kill -0 "$$frontend_pid" 2>/dev/null; then kill "$$frontend_pid" 2>/dev/null || true; fi; \
		if [ -n "$$backend_pid" ] && kill -0 "$$backend_pid" 2>/dev/null; then kill "$$backend_pid" 2>/dev/null || true; fi; \
		wait "$$frontend_pid" 2>/dev/null || true; \
		wait "$$backend_pid" 2>/dev/null || true; \
		exit $$status; \
	}; \
	trap cleanup INT TERM EXIT; \
	python3 -m http.server $(FRONTEND_PORT) --directory dist & frontend_pid=$$!; \
	go run ./native-scanner & backend_pid=$$!; \
	echo "Frontend: http://localhost:$(FRONTEND_PORT)"; \
	echo "Native scanner: http://127.0.0.1:4317"; \
	echo "Press Ctrl-C to stop both services."; \
	while kill -0 "$$frontend_pid" 2>/dev/null && kill -0 "$$backend_pid" 2>/dev/null; do sleep 1; done
