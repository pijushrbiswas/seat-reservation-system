.PHONY: install build dev deps up down test

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
