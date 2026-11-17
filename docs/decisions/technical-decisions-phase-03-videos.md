---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-17
scope_description: "Backend for Phase 03: background job queue technology, direct-to-storage upload of files up to 10GB, S3/MinIO usage layout, video worker topology and FFmpeg/ffprobe usage, unique public video IDs, streaming/download delivery, accepted formats, video status lifecycle and failure handling, and how the async pipeline is tested against real Compose services."
---

# Technical Decisions: Videos, Upload and Processing (Phase 03, backend)

_Subprojects in scope:_

- `nestjs-project/`: receives every TD below. New infra (object storage, Redis for the queue, video worker) lands in `nestjs-project/compose.yaml` and is exercised by real integration/e2e tests.
- `next-frontend/`: out of scope for this phase by explicit user decision. No Frontend TD here. TD-02, TD-06 and TD-07 are marked `Cross-layer` because they fix the HTTP contract a future frontend slice will consume; the frontend side of those contracts will be implemented (not re-decided) in that slice.

Inherited constraints (not reopened): `@nestjs/config` + Joi env validation with namespaced `registerAs` configs (phase-01 TD-01..03), custom JWT guards (phase-02-auth TD-02), class-validator DTOs (phase-02-auth TD-06), domain exception filter + error envelope (phase-02-auth TD-07), strict BFF on the frontend (next-frontend-config-base TD-03), `@nestjs/swagger` + exported `openapi.json` (openapi-docs-nestjs TD-01/02). Object storage is S3-compatible (MinIO in Compose, S3 in production) by user decision; only its usage is decided here.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` leaves the Message Queue as "TBD". Every later TD about the worker (TD-04), failure handling (TD-09) and tests (TD-10) depends on it. The workload is narrow: one job per completed upload, running seconds to a few minutes (ffprobe + one ffmpeg frame grab, see TD-05), volume in the order of uploads per minute, not thousands per second. The critical correctness point is the transition "upload completed → video marked as processing → job enqueued": if the DB write and the enqueue are not coordinated, a video can stay in `processing` forever with no job behind it.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- New `redis` service in Compose. API registers the queue with `BullModule.registerQueue`, worker consumes with `@Processor` / `WorkerHost`. Retries via `attempts` + `backoff`, failed jobs kept for inspection, `jobId` dedupe.
- **Pros:** official NestJS integration documented in the Nest "Queues" technique; most mature Node queue; progress events, sandboxed processors, Bull Board available; matches the diagram's separate queue container.
- **Cons:** one more stateful service in dev, CI and production; enqueue is a second system after the Postgres write (dual write), so the order of enqueue and status transition must be designed explicitly; Redis needs persistence (AOF) configured or jobs are lost on restart.

### Option B: pg-boss on the existing PostgreSQL
- Jobs live in a `pgboss` schema in the same `db` service. API calls `boss.send('video.process', { videoId }, { db })`, passing an adapter over the TypeORM `QueryRunner` so the job insert joins the same transaction that flips the video status. Worker uses `boss.work()`. Retries via `retryLimit` / `retryBackoff`, `deadLetter` queue, `singletonKey` per video.
- **Pros:** zero new infra (Postgres is already in Compose, tests, and production); transactional enqueue removes the dual-write problem entirely; built-in retry, backoff, expiration, dead letter and dedupe; integration tests use the same `db` service already wired in `create-test-data-source.ts`.
- **Cons:** no first-party Nest module (a ~40 LOC provider with `onModuleInit`/`onApplicationShutdown` is needed); polling-based pickup adds ~1-2s latency; job polling and row locks run on the transactional database; requires Node >= 22.12 (Dockerfile uses Node 25, fine); smaller ecosystem than BullMQ.

### Option C: RabbitMQ (`amqplib` or `@nestjs/microservices` RMQ transport)
- New `rabbitmq` service. API publishes to an exchange, worker consumes with manual ack; retries via dead-letter exchange + TTL queues.
- **Pros:** real broker with routing, fan-out and cross-language consumers; well suited if other services (non-Node) will subscribe to video events later.
- **Cons:** retry with backoff and delayed redelivery is hand-built from DLX/TTL topology; same dual-write problem as Option A; Nest's microservices transport is message-oriented, not job-oriented (no job state, no retry counters); heaviest operational footprint for a single job type.

**Recommendation:** Option B (pg-boss). With a single job type at low volume, the atomic "status + enqueue" write is free only under Option B because the queue lives in the same Postgres transaction, and it adds no service to Compose/CI/production. Option A is a close second and the better choice if the team values the official Nest module and the separate queue container of the target architecture.

**Decision:** A (BullMQ on Redis via `@nestjs/bullmq`). Rationale:
  (a) the target architecture (`docs/diagrams/software-arch.mermaid`) already defines the Message Queue as its own container, separate from the Database;
  (b) it keeps job polling and row locks off the transactional PostgreSQL;
  (c) `@nestjs/bullmq` is the official Nest module, documented in the Nest "Queues" technique.
  The dual-write risk (video in `processing` with no job) is mitigated without a reconciliation sweep: the enqueue happens in the upload-completion endpoint with a deterministic `jobId` equal to the video id, so it is idempotent (BullMQ ignores an `add` whose `jobId` already exists). The order is enqueue first, then the `draft → processing` transition; if the enqueue fails, the API does not perform the transition and responds with an error, so the client can safely retry the completion call. If the transition fails after a successful enqueue, the retried call finds the job already present (no-op) and applies the transition. Consequences for implementation: the completion endpoint must be idempotent end to end (including an already-completed multipart upload, detected via `HeadObject` on the object key), and the worker must accept a video still in `draft` at pickup.
  Alternative considered and rejected: pg-boss (Option B). It offers transactional enqueue, but it puts the queue inside the transactional database (contradicting (a) and (b)) and has no official Nest module (contradicting (c)); the idempotent enqueue above makes its main advantage unnecessary for this flow.

**Note:** Decision deliberately diverged from the Recommendation: BullMQ on Redis (Option A) was chosen over pg-boss (Option B) because the target architecture keeps the Message Queue as a container separate from the Database, job polling and locks stay off the transactional PostgreSQL, and `@nestjs/bullmq` is the official Nest module. The Recommendation above is kept as the research record; implementation follows the Decision, including the idempotent enqueue (`jobId = videoId`) before the `draft → processing` transition.

---

## TD-02: Large File Upload Protocol (up to 10GB, bytes never pass through the API)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The project plan requires 10GB uploads without impacting the system and the ability to resume after a dropped connection. The user ruled out proxying bytes through the API. A single presigned `PUT` is not viable because S3 caps a single PUT at 5GB, so the realistic options are S3 multipart driven by presigned part URLs, or a resumable-upload server. The handshake is a contract the future frontend must follow, hence `Cross-layer`.

**Options:**

### Option A: S3 multipart upload with presigned part URLs, orchestrated by the API
- `POST /videos/uploads` (auth) validates declared size/type, creates the video row as `draft` (TD-09), calls `CreateMultipartUpload` and returns `{ videoId, uploadId, partSize, partCount }`. Client asks for presigned `UploadPart` URLs in batches, PUTs parts straight to storage, then calls `POST .../complete` with the ETags; API runs `CompleteMultipartUpload`, checks the final size with `HeadObject`, enqueues (TD-01) and flips status. Resume uses `ListParts`; cancel uses `AbortMultipartUpload`.
- **Pros:** API only signs URLs (HMAC, no network I/O per part); works identically on MinIO and S3; resumable at part granularity; parallel part upload; only `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` added; Uppy's `@uppy/aws-s3` supports this flow if the frontend wants it.
- **Cons:** handshake has 3-4 endpoints the frontend must implement correctly; size cannot be enforced per presigned part URL, so the 10GB limit is enforced at initiate (declared size) and verified at complete (`HeadObject`), deleting the object if it exceeds; abandoned uploads leave orphan parts unless a bucket lifecycle rule aborts them.

### Option B: tus resumable protocol via a `tusd` server with S3 backend
- New `tusd` service in Compose writing to MinIO/S3; API authorizes uploads and learns about completion through tusd HTTP hooks (`pre-create`, `post-finish`).
- **Pros:** open standard protocol with mature clients (`tus-js-client`, Uppy); resume semantics handled by the server; byte-level resume offset.
- **Cons:** another service in Compose and production, with its own auth story (JWT must be forwarded and validated in the `pre-create` hook); bytes flow through tusd (not through Nest, but still through our infra, not directly to S3); completion arrives as a webhook, so the draft/status flow is split between hook handlers; testing needs the tusd container plus hook wiring.

**Recommendation:** Option A. It satisfies "bytes never touch our servers" literally (they go client → storage), adds no service, and maps one-to-one to the S3 API that both MinIO and production S3 implement. Contract parameters (cross-component, so fixed here): `partSize` fixed by the API at 100 MiB (a 10GB file is ~100 parts, far below the 10,000-part S3 cap), max declared size 10 GiB (`10 * 1024^3` bytes), presigned part URLs valid for 1h and re-requestable, and a bucket lifecycle rule `AbortIncompleteMultipartUpload` after 1 day. Depends on TD-03 for bucket/key/endpoint layout.

**Decision:** A (S3 multipart with presigned part URLs, orchestrated by the API), with the contract parameters above: 100 MiB parts, 10 GiB maximum checked at initiate and at complete, 1h part URLs, abort of incomplete uploads after 1 day.

---

## TD-03: Object Storage Usage Layout (buckets, keys, presign endpoint)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** S3-compatible storage is decided (MinIO in Compose, S3 in production). What is open is how API, worker, Compose, `.env.example` and the Joi schema agree on buckets, object keys and endpoints. One Docker-specific trap shapes every option: presigned URLs embed the host they were signed for, and the API inside Docker reaches MinIO as `http://minio:9000` while the browser reaches it as `http://localhost:9000`. A URL signed for `minio:9000` is unusable by the browser, and rewriting the host afterwards breaks the signature. So the API needs two S3 clients: one internal (server-side calls) and one configured with the public endpoint (only for presigning).

**Options:**

### Option A: Single private bucket, prefixes per video
- One bucket (e.g. `streamtube-media`), keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`. Every read goes through a presigned GET.
- **Pros:** simplest configuration (one bucket, one policy); one lifecycle rule set; ownership is by `videoId`, so channel renames never move objects.
- **Cons:** thumbnails also need presigned URLs, which change on every request and defeat browser/CDN caching in listings (home grid in Phase 07, channel page in Phase 04); lifecycle rules for incomplete uploads apply to thumbnails too (harmless but noisy).

### Option B: Two buckets: private `videos`, public-read `thumbnails`
- `streamtube-videos` (private, multipart target, presigned GET for stream/download) and `streamtube-thumbnails` (anonymous read policy). Keys `{videoId}/source` and `{videoId}/{thumbnailVersion}.jpg`.
- **Pros:** thumbnails get stable, cacheable URLs and need no signing in list endpoints; video bytes stay private and every access is authorized by the API; each bucket gets its own lifecycle policy (abort incomplete multipart only on videos); versioned thumbnail key lets Phase 04's custom thumbnail replace the generated one without cache staleness.
- **Cons:** two bucket names in config; thumbnails of unlisted videos are publicly fetchable if someone knows the `videoId` (UUID, unguessable, and the thumbnail alone reveals little); the public-read policy must be applied in both MinIO bootstrap and production IaC.

### Option C: Keys namespaced by channel (`{channelId}/{videoId}/...`)
- Same as A or B but with the channel as first key segment.
- **Pros:** per-channel prefix makes "delete everything of a channel" and per-channel storage accounting a prefix operation.
- **Cons:** couples storage layout to ownership; no capability in phases 03-07 needs per-channel storage operations; the key becomes derivable only with an extra DB lookup.

**Recommendation:** Option B. The public thumbnail bucket removes signing from every listing endpoint in later phases and keeps video bytes private, while keys by `videoId` keep storage independent of channel data. Common to every option and fixed here as the env contract (Joi schema + `compose.yaml` + `.env.example` + worker): `S3_ENDPOINT` (internal, `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (signing host, `http://localhost:9000` in dev), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (`true` for MinIO), `S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`. Buckets, policies and lifecycle rules are created by a one-shot `minio-init` Compose service (MinIO client `mc`), not by the application, mirroring production where buckets come from infrastructure.

**Decision:** B (private `videos` bucket + public-read `thumbnails` bucket, keys by `videoId`), with the env contract and the `minio-init` bootstrap above. The MinIO image in Compose is pinned to an explicit tag (never `latest`); the exact tag is chosen in `/plan-resolve` (library refs).

---

## TD-04: Video Worker Topology

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram shows a separate "Video Worker (FFmpeg)" container that reads/writes storage and updates the DB. FFmpeg work is CPU-bound and must not compete with HTTP request handling ("sem impacto na performance"). The worker needs the `Video` entity, storage client and config that the API already has, so the question is how much code and image it shares with the API.

**Options:**

### Option A: Same Nest codebase, separate entrypoint and Compose service
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). `WorkerModule` imports the shared config, TypeORM, storage and videos-domain modules plus the job consumer. Compose adds a `video-worker` service built from the same Dockerfile, with FFmpeg installed, running `npm run start:worker`.
- **Pros:** one codebase, one entity definition, one migration set, one lint/test/tsc pipeline; DI available in the consumer (unlike sandboxed processors); scales independently (`docker compose up --scale video-worker=N`); crash isolation from the API.
- **Cons:** the API image also carries FFmpeg unless a multi-stage/target split is added later (acceptable in dev); module boundaries must be explicit so the API does not register the consumer and the worker does not boot controllers.

### Option B: Consumer inside the API process
- The API module registers the job consumer; no new container.
- **Pros:** simplest setup; no new Compose service.
- **Cons:** FFmpeg child processes compete for CPU/memory with request handling on the same container, directly violating the "sem impacto na performance" capability; API restarts interrupt jobs; diverges from the architecture diagram.

### Option C: Standalone worker subproject (e.g. `video-worker/`)
- A separate package (Node or another language) with its own manifest, Dockerfile and DB access layer.
- **Pros:** strongest isolation; free choice of runtime (e.g. Go or Python for media tooling).
- **Cons:** duplicates entity/schema knowledge and config validation outside the TypeORM migrations source of truth; second lint/test/CI pipeline; new monorepo subproject for a single job type.

**Recommendation:** Option A. It matches the diagram's separate container while keeping a single source of truth for the `Video` entity, migrations and env validation, and Nest's `createApplicationContext` is the documented way to run non-HTTP Nest processes. Since tests run inside the `nestjs-api` container (per `nestjs-project/CLAUDE.md`), FFmpeg must be installed in `Dockerfile.dev`, which is shared by both services under this option.

**Decision:** A (same Nest codebase, `createApplicationContext` entrypoint, separate `video-worker` Compose service built from the shared `Dockerfile.dev` with FFmpeg installed). With TD-01 = A, the worker connects to Redis (queue) and to PostgreSQL (video entity).

---

## TD-05: Media Inspection and Thumbnail Extraction (FFmpeg/ffprobe usage)

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration and metadata (codecs, resolution, container) and grab one frame as thumbnail from a source file of up to 10GB stored in S3/MinIO. Two questions shape cost and reliability: how Node invokes FFmpeg, and how FFmpeg reads the source (download the whole file or read it remotely). `fluent-ffmpeg`, the historically common wrapper, is now deprecated and its repository archived.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` binaries directly, reading the source through a short-lived presigned GET URL
- `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', url])` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1 ...` for the thumbnail, written to a temp file and uploaded to the thumbnails bucket. FFmpeg's HTTP input uses range requests, so it reads only the header/index and the seeked region, not the whole 10GB.
- **Pros:** no wrapper dependency, typed JSON output parsed into a small DTO; no local disk proportional to file size; processing time independent of file size for metadata and single-frame grab; same code path on MinIO and S3.
- **Cons:** a small typed wrapper around `execFile` (timeouts, stderr capture, exit codes) must be written and tested; MP4 files with the `moov` atom at the end cost one extra range request (handled transparently by FFmpeg).

### Option B: Spawn binaries directly after downloading the source to a local temp volume
- Worker streams `GetObject` to `/tmp`, runs ffprobe/ffmpeg on the local file, deletes it afterwards.
- **Pros:** FFmpeg operates on a local file (fastest seeks, simplest debugging); no presigned URL needed for the worker.
- **Cons:** each job downloads up to 10GB before doing seconds of work; the worker needs disk equal to the largest file times concurrency; job duration scales with file size, raising timeout and retry costs.

### Option C: `fluent-ffmpeg` wrapper (either input mode)
- Fluent builder API over the same binaries.
- **Pros:** familiar API, many examples online.
- **Cons:** package deprecated and repository archived (no fixes for new FFmpeg versions); adds a dependency for what is two command lines in this phase.

**Recommendation:** Option A. Metadata and a single-frame grab only need a few MB of a 10GB file, so remote range reads keep job duration and disk usage flat regardless of upload size, and direct `execFile` avoids an archived dependency. Thumbnail frame choice (e.g. 10% of duration, clamped to the first seconds for short videos) and JPEG size are implementation details left to `implement`.

**Decision:** A (`execFile` on `ffprobe`/`ffmpeg`, source read through a short-lived presigned GET URL with range reads; no wrapper library).

---

## TD-06: Unique Public Video ID (URL strategy)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The project plan asks for "uma URL curta e única que nunca conflite com outro vídeo". Phase 05 adds unlisted videos "acessíveis apenas via link direto", so the public ID must also be unguessable: an enumerable ID turns unlisted into public. The ID appears in API routes (`/videos/{id}`) and in frontend routes, so it is a cross-layer contract.

**Options:**

### Option A: Expose the UUID primary key
- The `videos.id` UUID (v4, as used by `users` and `channels`) is the public ID.
- **Pros:** zero extra column or generation logic; 122 random bits, unguessable; consistent with existing entities.
- **Cons:** 36 characters, not the "URL curta" the plan asks for; couples the internal PK to public URLs forever.

### Option B: Random short ID in a dedicated unique column
- `videos.public_id` (e.g. 11 chars base64url from `crypto.randomBytes(8)`, 64 bits), generated at draft creation, unique index, regenerate on unique-violation. UUID stays the internal PK and FK target.
- **Pros:** short URLs (`/watch/aZ3_kP9xQ2w`); unguessable at 64 bits (collision probability negligible at any realistic volume, and the unique index makes conflicts impossible rather than unlikely); internal PK stays private and decoupled; no dependency (Node `crypto`).
- **Cons:** one more column and index; lookup by `public_id` in every public endpoint; retry-on-conflict path must exist even though it virtually never runs.

### Option C: Encoded sequential ID (Sqids/Hashids over a bigint)
- A sequence number encoded into a short string.
- **Pros:** shortest IDs; derived, not stored.
- **Cons:** reversible and ordered: anyone can enumerate neighbours, which breaks Phase 05 unlisted semantics; leaks upload volume; requires a sequential key the schema does not have (UUID PKs).

**Recommendation:** Option B. It is the only option that is both short (as the plan explicitly asks) and unguessable (required by Phase 05 unlisted videos), and keeping the UUID internal follows the pattern of the existing entities. The ID is assigned at draft creation (TD-02 initiate step), so it exists before the upload finishes.

**Decision:** B (11-char random base64url `public_id` in a unique column, generated at draft creation; UUID stays the internal PK).

---

## TD-07: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, which for progressive MP4/WebM means HTTP range requests answered with `206 Partial Content`. The diagram already draws "Frontend → Object Storage: Streams", and S3/MinIO serve `Range` natively. The open question is who answers the range requests and how the client gets an authorized URL, given that the frontend follows a strict BFF (browser never calls Nest directly) and that videos in this phase are only visible to their owner until Phase 04 adds publication.

**Options:**

### Option A: API hands out presigned GET URLs; storage serves bytes and ranges
- The API checks access and `status = ready`, then hands out a presigned GET URL for the source object. The stream URL is a plain presigned GET; the download URL adds `ResponseContentDisposition=attachment; filename="<title>.<ext>"`. The player fetches straight from storage, which answers range requests with 206.
- **Pros:** zero video bytes through Nest or the BFF; range/206, `Accept-Ranges`, ETag and conditional requests come from S3/MinIO for free; download and stream differ only by a signed response header; in production a CDN can sit in front of the bucket without API changes.
- **Cons:** S3 validates expiry on every range request, so a URL that expires mid-playback breaks seeks if the player keeps using the signed URL; a leaked URL works until it expires (acceptable for the access model in Phases 03-05); requires the public endpoint split from TD-03.

### Option B: API proxies ranges (`GetObject` with `Range`, piped as 206)
- Nest parses `Range`, calls `GetObject` with it and streams the body with `206`, `Content-Range`, `Accept-Ranges`.
- **Pros:** per-request authorization and full control over headers; storage stays fully private with no presigned URLs exposed.
- **Cons:** every byte of every view flows through the API (and through the BFF, given strict BFF), the exact load the phase must avoid; range parsing and edge cases (multi-range, `If-Range`, suffix ranges) are reimplemented; scaling playback means scaling the API.

### Option C: Adaptive streaming (HLS/DASH) generated by the worker
- Worker transcodes to multiple renditions and segments; player loads a manifest.
- **Pros:** adaptive bitrate, better experience on poor networks; segments are small and CDN-friendly.
- **Cons:** full transcode of up to 10GB per upload (CPU-hours, multiplied storage); needs an HLS player on the frontend (`hls.js`) for browsers without native HLS; goes beyond the capability, which only requires playback without full download.

**Recommendation:** Option A. Range/206 is already implemented by the storage the project uses, and presigned URLs keep the API and the BFF out of the byte path, which is the whole point of this phase. Access rule for this phase: owner only, `status = ready` only; Phase 04/05 widen it with visibility. Depends on TD-03 and on TD-08 (formats must be browser-playable for progressive streaming).

**Decision:** A (presigned GET URLs, storage serves 206), with the redirect as the primary contract:
  - `GET /videos/:publicId/stream` responds `302 Found` with `Location` set to a presigned GET URL of the source object.
  - `GET /videos/:publicId/download` responds `302 Found` with `Location` set to a presigned GET URL signed with `response-content-disposition: attachment; filename="<title>.<ext>"`.
  - A `<video src>` pointing to the stream endpoint works directly: the browser follows the redirect and MinIO/S3 answers the range requests with 206. Under strict BFF, the frontend's Route Handler forwards the 302 without following it (`redirect: 'manual'`), so bytes still go browser → storage.
  - No JSON `{ url, expiresAt }` endpoint in this phase: nothing in the Phase 03 scope needs it, and it can be added later without breaking the redirect contract.
  - Presigned URL expiry stays generous (suggested 6h) because a player that keeps the redirected URL revalidates it on each range request; the exact value is an implementation parameter.
  - Access rule for this phase: owner only (authenticated), `status = ready` only; other states respond with the domain error envelope (phase-02-auth TD-07).

---

## TD-08: Accepted Upload Formats and Playback Compatibility

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo)

**Context:** Under TD-07 Option A the original file is what the browser plays. Browsers play MP4 (H.264/AAC, and increasingly AV1/VP9) and WebM (VP8/VP9/AV1 + Opus/Vorbis), but not MKV/AVI/MOV with arbitrary codecs or HEVC everywhere. Either the platform restricts uploads to playable formats or the worker converts them. MIME type at initiate is client-declared and untrustworthy; only ffprobe in the worker (TD-05) knows the real codecs.

**Options:**

### Option A: Accept only browser-playable formats, validate with ffprobe, fail otherwise
- Initiate rejects declared types outside `video/mp4` and `video/webm`; worker checks container + video/audio codecs against an allowlist and marks the video `failed` with a specific reason (e.g. `UNSUPPORTED_CODEC`) if not playable.
- **Pros:** no transcoding cost; output is exactly what was uploaded; clear, actionable error for the user.
- **Cons:** users with MOV/MKV must convert before uploading; allowlist must be maintained.

### Option B: Accept common formats, transcode everything to H.264/AAC MP4 (faststart)
- Worker always produces a normalized MP4 rendition and streams that instead of the source.
- **Pros:** any common format plays everywhere; uniform output simplifies the player.
- **Cons:** full re-encode of up to 10GB per upload (very long jobs, high CPU), doubles storage, quality loss; job duration makes retries expensive.

### Option C: Accept common formats, remux when codecs are compatible, fail otherwise
- If codecs are playable but the container is not (e.g. H.264 in MKV/MOV), run `ffmpeg -c copy -movflags +faststart` into MP4; otherwise fail.
- **Pros:** broader acceptance than A with no re-encode; remux is I/O-bound and fast relative to transcode.
- **Cons:** still rewrites the whole file (full download + upload of up to 10GB, contradicting TD-05 Option A's remote-read model); two storage objects per remuxed video; more branches to test.

**Recommendation:** Option A. Accepting only browser-playable formats is enough for this phase, and it keeps the worker a light metadata/thumbnail job (consistent with TD-05) and makes the failure explicit; Option C can be added later as an additive step if users need MOV/MKV, without changing any contract.

**Decision:** A (MP4/WebM allowlist: declared type checked at initiate, real container/codecs checked by ffprobe in the worker; non-playable sources go to `failed` with `UNSUPPORTED_CODEC`).

---

## TD-09: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The phase requires a draft pre-registration when the upload starts and automatic processing after it ends, so the video row needs a status lifecycle. Phase 04 later adds "Fluxo de rascunho → publicação" and public/unlisted visibility, which is an editorial concern that may or may not share the same column. Failure handling also needs a rule: which errors are retried, how many times, and what the user sees.

**Options:**

### Option A: Single `status` column covering processing and publication
- One enum: `uploading → processing → draft → published`, plus `failed`.
- **Pros:** one column to filter on.
- **Cons:** mixes processing and editorial state in one enum; Phase 04 has to rewrite the enum and every query; cannot express "published but reprocessing".

### Option B: Separate `processing_status` now; editorial state left to Phase 04
- `processing_status` enum `uploading | processing | ready | failed`, plus `processing_error` and `processed_at`. The row is implicitly a draft from creation; Phase 04 adds `published_at`/visibility orthogonally.
- **Pros:** each column has one owner; Phase 04 adds publication without touching this one.
- **Cons:** the "rascunho" of the phase scope is implicit rather than a named state; two columns to consider in later listing queries.

### Option C: Option B plus an append-only status history table
- Every transition also inserts into `video_status_events`.
- **Pros:** full audit trail of attempts and errors.
- **Cons:** no capability in Phases 03-07 consumes the history; queue job records already keep attempt history for debugging.

### Option D: Single `status` with the processing lifecycle; visibility/publication as a separate field in Phase 04
- `status` enum `draft | processing | ready | failed`, plus the failure reason. `draft` is the pre-registration created when the upload starts (the "rascunho" of the project plan); `processing` means upload completed and job enqueued; `ready`/`failed` are the worker outcomes. Phase 04 adds visibility/publication as its own field when that phase arrives.
- **Pros:** the lifecycle the phase scope asks for is explicit and named; one column in this phase; publication stays out of this enum, so Phase 04 does not rewrite it.
- **Cons:** the word "draft" is used here for "upload not completed", while Phase 04's "rascunho → publicação" is about publication; Phase 04 must name its field so the two meanings do not collide.

**Recommendation:** Option B. A separate `processing_status` keeps apart the two concepts the plan calls "rascunho" (upload/processing state in this phase, publication state in Phase 04), so Phase 04 can add publication without migrating this column. Failure policy common to all options: transient errors retry with backoff, permanent errors fail immediately, and the original object is kept.

**Decision:** D (single `status` enum `draft → processing → ready | failed`; visibility/publication is a separate field added in Phase 04, not now). Lifecycle and failure policy:
  - `draft`: row created at upload initiate (TD-02), with `public_id` (TD-06).
  - `processing`: set by the completion endpoint after the job is enqueued with `jobId = videoId` (TD-01 ordering).
  - `ready`: set by the worker with duration, metadata and thumbnail key.
  - `failed`: set by the worker with the failure reason recorded (e.g. `UNSUPPORTED_CODEC`, `INVALID_MEDIA` for corrupted files).
  - Transient failures (storage timeouts, network, I/O errors from ffprobe/ffmpeg) retry with 3 attempts and exponential backoff (BullMQ `attempts: 3`, `backoff: { type: 'exponential' }`); after the last attempt the video goes to `failed`.
  - Permanent failures go to `failed` immediately, without retry (BullMQ `UnrecoverableError`), with the reason recorded.
  - The original object is kept in every failure case. The job is idempotent per `videoId` (deterministic object keys, overwrite on rerun).

**Note:** Decision deliberately diverged from the Recommendation: a single `status` with the lifecycle the phase scope asks for (Option D) was chosen over a separate `processing_status` (Option B), so the "rascunho" pre-registration is an explicit, named state in this phase. Visibility/publication stays out of this enum and becomes its own field in Phase 04. The Recommendation above is kept as the research record; implementation follows the Decision.

---

## TD-10: Testing Strategy for the Async Upload/Processing Pipeline

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The user requires the new infra (storage, queue, worker) to be exercised by real integration/e2e tests against Compose services, with no mocks for what Compose can run. The existing suites run inside the `nestjs-api` container, share one Postgres, and run `--runInBand`. The new difficulty is asynchrony: the e2e flow "initiate → upload parts → complete → processed" ends in a worker, and tests need real video files to feed ffprobe/ffmpeg.

**Options:**

### Option A: Worker booted in-process by the e2e test; real MinIO, real queue, real FFmpeg
- The e2e spec boots the API (`INestApplication`) and the `WorkerModule` application context in the same Jest process, uploads a tiny fixture video with real presigned part URLs against MinIO, and polls `GET /videos/{id}` until `ready`/`failed` with a timeout. Integration specs cover the storage service (MinIO), the job enqueue (queue backend) and the FFmpeg wrapper (real binaries on fixture files) separately.
- **Pros:** deterministic lifecycle (test starts and stops the worker); every component is real; failures surface in one process with one stack trace.
- **Cons:** FFmpeg must be installed in the image the tests run in (`Dockerfile.dev`); does not by itself test the `video-worker` container's entrypoint wiring.

### Option B: Black-box e2e against the running `video-worker` Compose service
- Tests drive the API and wait for the separate container to process.
- **Pros:** tests the real deployment topology including the worker entrypoint.
- **Cons:** the dev `video-worker` container also consumes jobs from the shared queue during tests (cross-contamination with dev data and nondeterminism); requires the worker container to be up and on the same code version; harder to debug failures across processes.

### Option C: Test the processor by calling it directly; no queue in e2e
- e2e stops at `processing`; the processor is integration-tested by invoking its handler with a job payload.
- **Pros:** fastest, simplest specs.
- **Cons:** the enqueue → consume path is never exercised end to end, which is exactly the integration the user asked to test for real.

**Recommendation:** Option A. It keeps every service real (MinIO, Redis-backed queue, FFmpeg) while giving the test full control of the worker lifecycle, which avoids the contamination of Option B under the shared-database, run-in-band constraint already in place. Fixtures: tiny committed media files (a ~1-2s H.264/AAC MP4, a WebM, and one unsupported-codec file for the TD-08 failure path), each under ~100KB, rather than generating them at test time. The 10GB limit is tested at the contract level (initiate rejects declared size > 10 GiB; complete rejects when `HeadObject` size disagrees), not by uploading 10GB.

**Decision:** A, with the real worker also running as a Compose service:
  - The `video-worker` Compose service (TD-04) always runs and consumes the same queue the API publishes to at runtime (same queue name, same Redis).
  - The e2e spec boots the `WorkerModule` processor inside the Jest process and runs the full initiate → parts → complete → `ready`/`failed` flow against real MinIO, Redis, PostgreSQL and FFmpeg.
  - So that the always-running Compose worker does not consume test jobs, the test environment isolates its queue namespace (BullMQ `prefix` or a dedicated Redis DB index via env) and uses dedicated test buckets (e.g. `S3_BUCKET_VIDEOS=streamtube-videos-test`), created by the same `minio-init` service. Queue name and code path stay identical; only the namespace differs.
  - Fixtures and the contract-level 10GB tests follow the Recommendation. `cleanAllTables` gains the `videos` table, and the test queue namespace is obliterated between suites.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background job queue technology | B (pg-boss on existing PostgreSQL) | A (BullMQ on Redis via `@nestjs/bullmq`; idempotent enqueue with `jobId = videoId` before the status transition) |
| TD-02 | Cross-layer | Large file upload protocol | A (S3 multipart with presigned part URLs) | A (100 MiB parts, 10 GiB max, 1h part URLs, abort incomplete after 1 day) |
| TD-03 | Backend | Object storage usage layout | B (private `videos` + public-read `thumbnails`) | B (keys by `videoId`, internal/public endpoint split, `minio-init`, pinned MinIO tag) |
| TD-04 | Backend | Video worker topology | A (same codebase, separate Compose service) | A |
| TD-05 | Backend | Media inspection and thumbnail extraction | A (`execFile` over presigned GET with range reads) | A |
| TD-06 | Cross-layer | Unique public video ID (URL strategy) | B (11-char random base64url `public_id`) | B |
| TD-07 | Cross-layer | Streaming and download delivery | A (presigned GET URLs; storage serves 206) | A (`GET /videos/:publicId/stream` and `/download` respond 302 to presigned URLs) |
| TD-08 | Backend | Accepted upload formats and playback compatibility | A (MP4/WebM allowlist validated by ffprobe) | A |
| TD-09 | Backend | Video status lifecycle and failure handling | B (separate `processing_status`) | D (single `status`: `draft → processing → ready / failed`; 3 retries with exponential backoff for transient errors) |
| TD-10 | Backend | Testing strategy for the async pipeline | A (worker in-process in e2e) | A (plus `video-worker` Compose service on the runtime queue; tests isolated by queue prefix and test buckets) |

---

## Notes for downstream pipeline

- Phase folder: this document's slug is `phase-03-videos`, so the planning artifacts live in `docs/phases/phase-03-videos/` (same pattern as `technical-decisions-phase-02-auth.md` → `docs/phases/phase-02-auth/`).
- Dependency chain: TD-03 → TD-02, TD-05, TD-07 (endpoint split and buckets); TD-01 → TD-04, TD-09, TD-10 (Redis connection, retry primitives, test queue isolation); TD-08 → TD-07 (progressive playback assumes browser-playable sources); TD-05 → TD-08 (ffprobe is the validation source).
- Env contract additions beyond TD-03: Redis connection keys (`REDIS_HOST=redis`, `REDIS_PORT`) and the queue namespace key used by TD-10 test isolation go through the Joi schema, `compose.yaml` and `.env.example`. Redis in Compose needs AOF persistence enabled so queued jobs survive a restart.
- Completion endpoint idempotency (TD-01 + TD-02 + TD-09): a retried `complete` call must succeed when the multipart upload was already completed (object present via `HeadObject`), when the job already exists (BullMQ dedupe by `jobId`), and when the status is already `processing`. The worker must accept a video still in `draft` at pickup.
- Naming caution for Phase 04 (TD-09 = D): `status = draft` here means "upload not completed yet". Phase 04's "rascunho → publicação" is a different concept and should use a separately named field (e.g. `visibility` or `published_at`) so a `ready` video that is not published is not confused with `status = draft`.
- MinIO image sourcing (TD-03): MinIO stopped publishing community Docker images in late 2025; Compose pins an explicit tag, chosen in `/plan-resolve` (library refs).
- `docs/diagrams/software-arch.mermaid` needs updating: the Message Queue container becomes "Redis (BullMQ)", the `Rel(api, storage, "Uploads")` arrow becomes "Presigns", and a new `Rel(frontend, storage, "Uploads parts")` is added.
- `nestjs-project/CLAUDE.md` should gain the new services (`minio`, `minio-init`, `redis`, `video-worker`) in the Services list and readiness checks, plus the `start:worker` command.
- Out of scope here and left to Phase 04: custom thumbnail upload, publication/visibility, title/description editing. Video title in Phase 03 defaults to the uploaded file name (implementation detail).

Sources consulted during research:

- [NestJS docs, Queues technique (v11)](https://docs.nestjs.com/techniques/queues): `@nestjs/bullmq`, `WorkerHost`, sandboxed processors without DI.
- [pg-boss docs](https://github.com/timgit/pg-boss/tree/master/docs): queue options (`retryLimit`, `retryBackoff`, `deadLetter`, `expireInSeconds`), `send()` with custom `db` adapter for transactional enqueue.
- [AWS SDK for JavaScript v3, `@aws-sdk/s3-request-presigner`](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md): `getSignedUrl` for any command (including `UploadPartCommand`), default 900s expiry; `forcePathStyle` in v3 client config.
- [Supabase storage PR upgrading to pg-boss 12](https://github.com/supabase/storage/pull/1198): Node >= 22.12 requirement for pg-boss 12.
- [fluent-ffmpeg on npm (deprecation notice)](https://npmjs.com/package/fluent-ffmpeg) and [fluent-ffmpeg GitHub org (archived repo)](https://github.com/fluent-ffmpeg).
- [Chainguard: free MinIO containers](https://www.chainguard.dev/unchained/secure-and-free-minio-chainguard-containers), [linuxiac: MinIO source-only decision](https://linuxiac.com/minio-with-yet-another-controversial-move/), [scnd/minio-mirror](https://hub.docker.com/r/scnd/minio-mirror): MinIO community image status.
