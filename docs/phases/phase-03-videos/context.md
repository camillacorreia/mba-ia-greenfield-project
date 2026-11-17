---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-17T12:56:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T13:23:30-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-17T13:23:51-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-17T12:56:47-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-17T12:56:47-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-17T12:56:47-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-17T12:56:47-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-17T12:56:47-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _None explicitly mentioned in the phase 03 section._
**Deferred subprojects:** _None._
**Sequencing notes:** > Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ on Redis via `@nestjs/bullmq`) | bullmq, @nestjs/bullmq, ioredis |
|     └─ Last revision: 2026-11-17 — Libraries field filled with `bullmq` (^6.7.7), `@nestjs/bullmq` (^12.0.2) and… | | | | | | |
| phase-03-videos/TD-02 | phase | Cross-layer | Large File Upload Protocol (up to 10GB, bytes bypass API) | decided | A (S3 multipart, presigned part URLs, API-orchestrated) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Usage Layout (buckets, keys, presign endpoint) | decided | B (private `videos` + public-read `thumbnails`, keys by videoId) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-11-17 — MinIO images pinned to the community fork: `pgsty/minio:RELEASE.2026-08-04T… | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Topology | decided | A (same Nest codebase, `createApplicationContext`, `video-worker` service) | — |
| phase-03-videos/TD-05 | phase | Backend | Media Inspection and Thumbnail Extraction (FFmpeg/ffprobe) | decided | A (`execFile` on ffprobe/ffmpeg via presigned GET, no wrapper) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Unique Public Video ID (URL strategy) | decided | B (11-char base64url `public_id`, UUID stays PK) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Streaming and Download Delivery | decided | A (presigned GET URLs, storage serves 206, redirect contract) | — |
| phase-03-videos/TD-08 | phase | Backend | Accepted Upload Formats and Playback Compatibility | decided | A (MP4/WebM allowlist + ffprobe codec check) | — |
| phase-03-videos/TD-09 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | D (single `status` enum draft → processing → ready / failed) | — |
|     └─ Last revision: 2026-11-17 — New transition `draft → failed` for abandoned uploads. A scheduled job (BullMQ… | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | Testing Strategy for the Async Upload/Processing Pipeline | decided | A (real worker as a Compose service) | — |
|     └─ Last revision: 2026-11-17 — Test isolation mechanism fixed. The e2e/integration test boots its own worker … | | | | | | |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-08, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-10 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-10 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** With a single job type at low volume, the atomic "status + enqueue" write is free only under Option B because the queue lives in the same Postgres transaction, and it adds no service to Compose/CI/production. Option A is a close second and the better choice if the team values the official Nest module and the separate queue container of the target architecture.
**Note:** Decision deliberately diverged from the Recommendation: BullMQ on Redis (Option A) was chosen over pg-boss (Option B) because the target architecture keeps the Message Queue as a container separate from the Database, job polling and locks stay off the transactional PostgreSQL, and `@nestjs/bullmq` is the official Nest module. The Recommendation above is kept as the research record; implementation follows the Decision, including the idempotent enqueue (`jobId = videoId`) before the `draft → processing` transition.
**Libraries:** bullmq, @nestjs/bullmq, ioredis

**Revisions:**
- 2026-11-17 — Libraries field filled with `bullmq` (^6.7.7), `@nestjs/bullmq` (^12.0.2) and `ioredis` (^6.0.0); Redis image pinned to `redis:8.10.3-alpine`. Rationale: IC-1 of plan-validate, the decided Option A names BullMQ and `@nestjs/bullmq` but the Libraries field was empty. BullMQ 6 loads `ioredis` lazily as an optional peer dependency (it is no longer installed transitively), so `ioredis` must be a direct dependency for the default host/port connection. BullMQ 6 also removed the legacy repeatable API (`add(..., { repeat })`); scheduled jobs use Job Schedulers (`upsertJobScheduler`), see the TD-09 revision.

### phase-03-videos/TD-02

**Recommendation:** It satisfies "bytes never touch our servers" literally (they go client → storage), adds no service, and maps one-to-one to the S3 API that both MinIO and production S3 implement. Contract parameters (cross-component, so fixed here): `partSize` fixed by the API at 100 MiB (a 10GB file is ~100 parts, far below the 10,000-part S3 cap), max declared size 10 GiB (`10 * 1024^3` bytes), presigned part URLs valid for 1h and re-requestable, and a bucket lifecycle rule `AbortIncompleteMultipartUpload` after 1 day. Depends on TD-03 for bucket/key/endpoint layout.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** The public thumbnail bucket removes signing from every listing endpoint in later phases and keeps video bytes private, while keys by `videoId` keep storage independent of channel data. Common to every option and fixed here as the env contract (Joi schema + `compose.yaml` + `.env.example` + worker): `S3_ENDPOINT` (internal, `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (signing host, `http://localhost:9000` in dev), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (`true` for MinIO), `S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`. Buckets, policies and lifecycle rules are created by a one-shot `minio-init` Compose service (MinIO client `mc`), not by the application, mirroring production where buckets come from infrastructure.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-11-17 — S3 client fixed as AWS SDK v3: `@aws-sdk/client-s3` (^3.1170.0) for `CreateMultipartUpload`, `CompleteMultipartUpload`, `AbortMultipartUpload` and `HeadObject`, plus `@aws-sdk/s3-request-presigner` (^3.1170.0, same version line) for presigned `UploadPart` and `GetObject`. Rationale: MD-1 of plan-validate, no TD named the library; the same client works against MinIO (`forcePathStyle: true` + custom `endpoint`) and production S3, which this TD already requires.
- 2026-11-17 — Signing endpoint fixed per consumer. URLs delivered to a client outside the Compose network (upload part URLs, stream and download redirects) are signed by the client configured with `S3_PUBLIC_ENDPOINT`. URLs consumed inside the Compose network (worker ffprobe/ffmpeg presigned GET from TD-05, integration and e2e tests running in the `nestjs-api` container) are signed with `S3_ENDPOINT`. In the test environment the API's client-facing signer therefore points to the internal host (`S3_PUBLIC_ENDPOINT=http://minio:9000` in the test env), since the test client lives inside the network. Rationale: AMB-2 of plan-validate, the host is part of the SigV4 signature and a URL signed for `localhost:9000` does not resolve from inside a container.
- 2026-11-17 — MinIO images pinned to the community fork: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` for the `minio` service and `pgsty/mc:RELEASE.2026-11-12T00-00-00Z` for `minio-init`, both multi-arch (amd64/arm64) and verified with `docker manifest inspect`. Rationale: the official community-edition images are no longer published (`minio/minio` and `minio/mc` fail on any tag), and the Pigsty fork keeps explicit release tags with the same S3 API, so the decided Option B and the env contract stay unchanged.

### phase-03-videos/TD-04

**Recommendation:** It matches the diagram's separate container while keeping a single source of truth for the `Video` entity, migrations and env validation, and Nest's `createApplicationContext` is the documented way to run non-HTTP Nest processes. Since tests run inside the `nestjs-api` container (per `nestjs-project/CLAUDE.md`), FFmpeg must be installed in `Dockerfile.dev`, which is shared by both services under this option.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Metadata and a single-frame grab only need a few MB of a 10GB file, so remote range reads keep job duration and disk usage flat regardless of upload size, and direct `execFile` avoids an archived dependency. Thumbnail frame choice (e.g. 10% of duration, clamped to the first seconds for short videos) and JPEG size are implementation details left to `implement`.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It is the only option that is both short (as the plan explicitly asks) and unguessable (required by Phase 05 unlisted videos), and keeping the UUID internal follows the pattern of the existing entities. The ID is assigned at draft creation (TD-02 initiate step), so it exists before the upload finishes.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Range/206 is already implemented by the storage the project uses, and presigned URLs keep the API and the BFF out of the byte path, which is the whole point of this phase. Access rule for this phase: owner only, `status = ready` only; Phase 04/05 widen it with visibility. Depends on TD-03 and on TD-08 (formats must be browser-playable for progressive streaming).
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Accepting only browser-playable formats is enough for this phase, and it keeps the worker a light metadata/thumbnail job (consistent with TD-05) and makes the failure explicit; Option C can be added later as an additive step if users need MOV/MKV, without changing any contract.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** A separate `processing_status` keeps apart the two concepts the plan calls "rascunho" (upload/processing state in this phase, publication state in Phase 04), so Phase 04 can add publication without migrating this column. Failure policy common to all options: transient errors retry with backoff, permanent errors fail immediately, and the original object is kept.
**Note:** Decision deliberately diverged from the Recommendation: a single `status` with the lifecycle the phase scope asks for (Option D) was chosen over a separate `processing_status` (Option B), so the "rascunho" pre-registration is an explicit, named state in this phase. Visibility/publication stays out of this enum and becomes its own field in Phase 04. The Recommendation above is kept as the research record; implementation follows the Decision.
**Libraries:** —

**Revisions:**
- 2026-11-17 — New transition `draft → failed` for abandoned uploads. A scheduled job (BullMQ Job Scheduler via `upsertJobScheduler`, on the same Redis/BullMQ infrastructure of TD-01, consumed by the `video-worker`) marks as `failed`, with reason `UPLOAD_EXPIRED`, every video in `draft` created more than 1 day ago, aligned with the TD-02 lifecycle rule that aborts incomplete multipart uploads after 1 day. For each expired draft it also tries `AbortMultipartUpload` on the storage (the row keeps the multipart `uploadId`; a `NoSuchUpload` answer means the lifecycle rule already aborted it and is not an error). The run cadence is an implementation parameter. Rationale: AMB-1 of plan-validate, without this rule an abandoned upload left the row in `draft` forever with a `public_id` allocated.

### phase-03-videos/TD-10

**Recommendation:** It keeps every service real (MinIO, Redis-backed queue, FFmpeg) while giving the test full control of the worker lifecycle, which avoids the contamination of Option B under the shared-database, run-in-band constraint already in place. Fixtures: tiny committed media files (a ~1-2s H.264/AAC MP4, a WebM, and one unsupported-codec file for the TD-08 failure path), each under ~100KB, rather than generating them at test time. The 10GB limit is tested at the contract level (initiate rejects declared size > 10 GiB; complete rejects when `HeadObject` size disagrees), not by uploading 10GB.
**Libraries:** —

**Revisions:**
- 2026-11-17 — Test isolation mechanism fixed. The e2e/integration test boots its own worker (the processor) through `createApplicationContext` or a `TestingModule`, configured with a queue prefix exclusive to tests (BullMQ `prefix` from env) and the test buckets; the Redis DB index alternative is dropped. Since the `video-worker` Compose service only listens on the runtime prefix, it never consumes test jobs. Rationale: AMB-4 of plan-validate, the Decision listed prefix or DB index as alternatives and did not state who runs the processor during tests.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** É a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** O custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema,... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule`... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory phase-03-videos and then rerun /plan-context phase-03-videos to activate UI checks._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance (tela de upload no `next-frontend/`) | deferred | deferred_to_next_phase (AMB-3, 2026-11-17): phase 03 is backend-only and the upload UI lands in a future frontend slice, following the phase-02-auth / phase-02-auth-frontend split. Pending for that slice: CORS on the MinIO `videos` bucket allowing `PUT` from the frontend origin with `ETag` in `ExposeHeaders` (the browser must read each part's `ETag` for `CompleteMultipartUpload`). The backend contract (initiate, part URLs, complete) ships in this phase. | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) (player no `next-frontend/`) | deferred | deferred_to_next_phase (AMB-3, 2026-11-17): phase 03 is backend-only. Pending for the frontend slice: the BFF must bridge the `302` redirect of `GET /videos/:publicId/stream`, since a `<video>` element cannot send the Bearer token. The backend redirect contract ships in this phase. | phase-03-videos/TD-07, phase-03-videos/TD-08 |
| Download do vídeo pelo usuário (botão de download no `next-frontend/`) | deferred | deferred_to_next_phase (AMB-3, 2026-11-17): phase 03 is backend-only. Pending for the frontend slice: the same BFF bridging of the `302` redirect, for `GET /videos/:publicId/download`. The backend contract ships in this phase. | phase-03-videos/TD-07 |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
