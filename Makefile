.PHONY: install build dev deps up down test burst pg-top

BASE_URL ?= $(or $(BASE),http://localhost:8080)

install:
	npm ci

build:
	npm run build

# Postgres (localhost:5433) and Redis (localhost:6380) for local dev and tests
deps:
	docker compose up -d --wait postgres redis

# Full stack in containers: app on http://localhost:8080, Grafana on http://localhost:3000 (admin / admin), Prometheus on http://localhost:9090
up:
	docker compose up -d --build --wait

down:
	docker compose down -v

dev: deps
	set -a; . ./.env.example; set +a; npm run dev

test: deps
	npm test

# On-sale stampede + hot-seat storm + final reconciliation against any deployment:
#   make burst BASE_URL=https://your-app.onrender.com ADMIN_TOKEN=...
burst:
	BASE_URL=$(BASE_URL) npm run --silent burst -- $(BASE_URL)

# The ten statements that used the most database time (needs the pg_stat_statements extension, created on a fresh database by `make up`).
# Run `make pg-top` after a burst. To start measuring from zero, run: docker compose exec postgres psql -U seats -d seats -c "SELECT pg_stat_statements_reset()"
pg-top:
	docker compose exec -T postgres psql -U seats -d seats -c "SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms, rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 10"
