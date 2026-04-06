# Nudge

Backend for the AI Accountability Companion: **Fastify** HTTP API, **BullMQ** worker, **Supabase Postgres**, **S3** for exports. Architecture is documented in [`docs/adr-001-backend-mvp-architecture.md`](docs/adr-001-backend-mvp-architecture.md).

## Requirements

- Node.js ≥ 22
- pnpm
- Supabase project (apply migrations under `supabase/migrations/`)
- Redis (local: Docker Compose)

## Quick start

```bash
cp .env.example .env
# Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL, and other keys as needed.
docker compose up -d
pnpm install
pnpm dev
```

Smoke: `GET /health`, `GET /ready`.

## Scripts

| Command      | Description                          |
| ------------ | ------------------------------------ |
| `pnpm dev`   | API + worker (loads `.env`)          |
| `pnpm test`  | Vitest                               |
| `pnpm build` | Compile TypeScript to `dist/`        |
| `pnpm lint`  | ESLint                               |

Do not commit `.env`; copy from [`.env.example`](.env.example).
