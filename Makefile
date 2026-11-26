.PHONY: setup check up smoke down

setup:
	npm ci --ignore-scripts

check:
	@: "$${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable PostgreSQL database}"
	npm run format:check
	npm run lint
	npm run typecheck
	npm run test:coverage
	npm audit --audit-level=low
	npm run build

up:
	docker compose up --build --wait

smoke:
	npm run smoke

down:
	docker compose down
