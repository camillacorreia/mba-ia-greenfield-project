# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means `docker compose up -d`, which starts the **infrastructure services** (database, mail, Redis, MinIO and its one-shot `minio-init`) **plus the `video-worker`**. The worker is processing infrastructure: it consumes the `video-processing` queue and has no HTTP port, so it is part of every environment start. The NestJS **HTTP server** of the API is **not** part of this step: never run `npm run start:dev` unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting the environment, always confirm the containers are up before proceeding:

```bash
docker compose ps -a   # db, mailpit, redis, minio, nestjs-api, video-worker "running"; minio-init "Exited (0)"
```

Then verify each service is actually ready, not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -f http://localhost:9000/minio/health/ready` — expect exit code 0 (the console is at http://localhost:9001)
- **minio-init:** `docker compose ps -a minio-init` — expect `Exited (0)`; it creates the buckets and is safe to re-run
- **video-worker:** `docker compose logs video-worker | grep "Video worker ready"` — expect `Video worker ready, consuming "video-processing" with prefix "streamtube" on redis:6379`. On a fresh clone the log instead repeats `video-worker: aguardando node_modules, rode docker compose exec nestjs-api npm install`; run that install and the worker starts by itself, no command in the worker container needed

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (container stays idle until `npm run start:dev` is run in it)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP on `1025`, web UI on `8025`
- `redis` — Redis 8 (`redis:8.10.3-alpine`), port `6379`, backs the BullMQ queue `video-processing`
- `minio` — S3-compatible object storage (`pgsty/minio`), API on `9000`, console on `9001`, data in the `minio-data` volume
- `minio-init` — one-shot (`pgsty/mc`) that runs `docker/minio-init.sh`: creates `videos`, `thumbnails`, `videos-test` and `thumbnails-test`, makes the thumbnail buckets publicly readable and sets `api stale_uploads_expiry=24h` (MinIO aborts incomplete multipart uploads after 1 day; it rejects the S3 lifecycle rule `AbortIncompleteMultipartUpload`)
- `video-worker` — same image and volume as `nestjs-api`, runs `npm run start:worker:dev` (Nest application context, no HTTP), `restart: unless-stopped`

The dev image (`Dockerfile.dev`) includes `ffmpeg` and `ffprobe`, used by the worker and by the integration tests that run inside `nestjs-api`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled worker (dist/worker.js, after npm run build)

npm test                                 # Unit + integration tests (always with --runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database and the Redis test prefix. They **must** run with `--runInBand`, and both scripts already pass it:

```bash
docker compose exec nestjs-api npm test           # jest --runInBand
docker compose exec nestjs-api npm run test:e2e   # jest --config ./test/jest-e2e.json --runInBand
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles` — `["dotenv/config", "<rootDir>/test/setup-test-env.ts"]` in `package.json` (rootDir `src`) and `["dotenv/config", "<rootDir>/../src/test/setup-test-env.ts"]` in `test/jest-e2e.json` (rootDir `test`). `dotenv/config` loads `.env` inside the Jest process (without it `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`). `setup-test-env.ts` runs right after it and isolates every suite from runtime data: `QUEUE_PREFIX=streamtube-test`, `S3_BUCKET_VIDEOS=videos-test`, `S3_BUCKET_THUMBNAILS=thumbnails-test` and `S3_PUBLIC_ENDPOINT` equal to `S3_ENDPOINT` (the test client is inside the Compose network). The `video-worker` only listens to the `streamtube` prefix, so it never consumes test jobs.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `npm test` and `npm run test:e2e` pass `--runInBand`: the suites share the database and the test queue prefix, and clean tables in `beforeEach`.

Tests that need the queue consumer start it themselves with `startTestProcessor()` (`src/test/start-test-processor.ts`), which boots `VideoProcessingModule` on the test prefix. Media fixtures for those tests live in `test/fixtures/media/` (generation commands in its README).

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

The worker has its own output folder: `npm run start:worker:dev` compiles with `tsconfig.worker.json` into `dist-worker/`, while `npm run build` / `npm run start:dev` use `dist/`. Both run on the same bind-mounted volume and `nest-cli.json` has `deleteOutDir: true`, so sharing one folder would make each process delete the other's output. `dist-worker` is excluded in `tsconfig.json`, `tsconfig.build.json`, `.gitignore` and the ESLint ignores.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos

### Modules

- `VideosModule` (`src/videos/`) — `Video` entity, `VideosController` (all `/videos` routes), `VideosService` (upload, owner check, read URLs) and `VideoLifecycleService` (guarded status transitions, exported). The `videos` table stores, among others, `title`, `status`, `storage_key` (key of the original in the videos bucket), `thumbnail_key`, duration and media metadata, and the unique `public_id`.
- `StorageModule` (`src/storage/`) — the only place that imports the AWS SDK. Two clients: `S3_INTERNAL_CLIENT` on `S3_ENDPOINT` (server-side calls and URLs read inside Compose) and `S3_PUBLIC_SIGNER` on `S3_PUBLIC_ENDPOINT` (URLs handed to clients). `StorageService` translates SDK errors into `StorageNoSuchUploadError` / `StorageInvalidPartsError`.
- `VideoProcessingQueueModule` (`src/video-processing/`) — registers the BullMQ queue `video-processing` and `VideoProcessingProducer` (`jobId = video id`, 3 attempts, exponential backoff). Imported by the API; it has no consumer.
- `VideoProcessingModule` — the consumer: `VideoProcessor` (`process-video` and `expire-drafts`), `VideoProcessingService` (ffprobe, codec policy, thumbnail), `MediaInspector` (`execFile` on `ffprobe`/`ffmpeg`), `DraftExpiryService` and `DraftExpiryScheduler` (Job Scheduler `expire-draft-uploads`, every 1h). **Never import it in `AppModule`.**
- `WorkerModule` (`src/worker.module.ts`, entrypoint `src/worker.ts`) — root of the worker process: same `configModuleOptions` and `buildTypeOrmOptions` as `AppModule`, plus `UsersModule` (so `autoLoadEntities` knows `User`, referenced by `Channel`) and `VideoProcessingModule`.

### Upload flow

1. `POST /videos` validates size (≤ 10 GiB) and type (`video/mp4`, `video/webm`), opens the multipart upload and stores the draft with an 11-char `public_id`, the optional `title` (1..100 chars, trimmed; defaults to the file name without extension, see `defaultTitleFromFilename`) and `storage_key`. The key is the video `id` (TD-03), persisted so storage calls, the worker, stream and download read it from the column instead of deriving it. Returns `part_size` (100 MiB) and `part_count`.
2. `POST /videos/:publicId/upload/part-urls` signs `UploadPart` URLs (1h). The client `PUT`s each part straight to the storage and keeps the `ETag`.
3. `POST /videos/:publicId/upload/complete` completes the multipart, checks `HeadObject` size against the declared size, enqueues `process-video` and only then moves the video to `processing` (202).
4. The worker probes the file (at its `storage_key`) through an internal signed URL, checks container and codecs, writes the thumbnail `{id}.jpg` to the public thumbnails bucket and marks the video `ready`.
5. `GET /videos/:publicId` returns title, status and metadata (never `id`, `channel_id`, `upload_id` nor `storage_key`); `GET /videos/:publicId/stream` and `/download` redirect (302, empty body) to signed `GetObject` URLs (1h). The storage answers `Range` with 206, so bytes never go through the API.

Every `/videos/:publicId` route is owner-only: another channel's video answers exactly like a missing one (`404 VIDEO_NOT_FOUND`).

### Status lifecycle

`draft → processing → ready | failed`, plus `draft → failed` for abandoned uploads. Every transition is a single conditional `UPDATE ... WHERE status IN (...)`, so duplicate or late jobs never move a video backwards. `failure_reason` values: `UPLOAD_SIZE_MISMATCH` (API, at complete), `UPLOAD_EXPIRED` (drafts older than 24h, hourly `expire-drafts`), `INVALID_MEDIA`, `UNSUPPORTED_CONTAINER`, `UNSUPPORTED_CODEC` (permanent, `UnrecoverableError`, no retry) and `PROCESSING_FAILED` (transient error on the last of 3 attempts). The original object is always kept in the bucket.

### Environment variables

| Variable | Dev value (`.env.example`) | Notes |
|----------|----------------------------|-------|
| `S3_ENDPOINT` | `http://minio:9000` | Required URI. Internal client |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Required URI. Host of the URLs given to clients and of `thumbnail_url` |
| `S3_REGION` | `us-east-1` | Default `us-east-1` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `streamtube` / `streamtube-secret` | Required. Also used by `minio` and `minio-init` |
| `S3_FORCE_PATH_STYLE` | `true` | `'true' \| 'false'`, default `'false'` |
| `S3_BUCKET_VIDEOS` / `S3_BUCKET_THUMBNAILS` | `videos` / `thumbnails` | Required |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | Defaults `redis` / `6379` |
| `QUEUE_PREFIX` | `streamtube` | Default `streamtube`; tests force `streamtube-test` |

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
