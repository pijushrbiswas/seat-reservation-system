.PHONY: install build dev deps up down test burst

BASE_URL ?= $(or $(BASE),http://localhost:8080)

install:
	npm ci

build:
	npm run build

# Postgres (localhost:5433) and Redis (localhost:6380) for local dev and tests
deps:
	docker compose up -d --wait postgres redis

# Full stack in containers: app on http://localhost:8080
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
