---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 6
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T13:12:13-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T13:09:32-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-01 decision names @nestjs/bullmq + BullMQ but its Libraries field is empty"
  - id: AMB-1
    status: open
    summary: "Abandoned uploads: draft rows outlive the 1-day multipart abort, no rule given"
  - id: AMB-2
    status: open
    summary: "Which S3 endpoint signs URLs consumed inside containers (worker ffprobe, e2e)"
  - id: AMB-3
    status: open
    summary: "Phase 03 frontend boundary undefined: upload/player UI in or out of scope"
  - id: AMB-4
    status: open
    summary: "TD-10 worker test isolation: dev video-worker may consume test jobs"
  - id: MD-1
    status: open
    summary: "No TD picks the S3 client library for multipart, presign and HeadObject"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-01` is decided as "A (BullMQ on Redis via `@nestjs/bullmq`)" and its Note fixes `jobId = videoId` idempotent enqueue (a BullMQ API), but the Decisions Index and Decisions Detail both record `Libraries: —`. `/plan-build` and `library-refs.md` read the Libraries field to pin versions and fetch docs, so `bullmq` and `@nestjs/bullmq` would be missing from the library refs of the phase. Explicit choice: add the Libraries line to TD-01 (Append revision, the decided letter does not change).

### Ambiguities

- **AMB-1** — Capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" creates the `draft` row at initiate (TD-02 + TD-06), and TD-02 aborts incomplete multipart uploads in storage after 1 day via bucket lifecycle. Nothing says what happens to the DB row when the upload is abandoned: it stays `draft` forever (TD-09 has no transition out of `draft` except `processing`), with a `public_id` already allocated. Explicit choice: (a) accept orphan drafts in this phase and let Phase 04 listing handle them; (b) add an explicit abort endpoint (`AbortMultipartUpload` + row delete or `failed`); (c) add a scheduled cleanup job on the TD-01 queue that expires drafts older than the lifecycle window.
- **AMB-2** — TD-03 defines two endpoints, `S3_ENDPOINT` (internal, `http://minio:9000`) and `S3_PUBLIC_ENDPOINT` (signing host, `http://localhost:9000` in dev), but does not say which one signs URLs consumed from inside the Compose network. TD-05 has the worker run ffprobe/ffmpeg "via presigned GET", and TD-10 runs e2e tests inside the `nestjs-api` container uploading parts through presigned URLs (TD-02). A URL signed for `localhost:9000` does not resolve from inside a container, and the host is part of the SigV4 signature, so it cannot be rewritten after signing. Explicit choice: state per consumer which endpoint signs (e.g. browser-facing presigns use `S3_PUBLIC_ENDPOINT`, worker and test presigns use `S3_ENDPOINT`), as a revision of TD-03 or TD-05.
- **AMB-3** — The phase boundary with `next-frontend` is not defined. `**Affected subprojects:**` is empty, `## UI Inventory` is deferred, yet TD-02, TD-06 and TD-07 are `Scope: Cross-layer` and TD-07 talks about keeping "the API and the BFF out of the byte path". The deliverables ("upload de até 10GB funcional", "streaming funcionando") can be read as backend contract plus tests only, or as an end-to-end browser flow. If the browser is in scope, part uploads go straight to MinIO and need CORS with `ETag` exposed (required by `CompleteMultipartUpload`), which `minio-init` in TD-03 does not mention, and the TD-07 redirect contract has to be bridged by the BFF since a `<video>` element cannot send the Bearer token. Explicit choice: (a) backend-only phase, frontend upload/player deferred (record in `## Non-UI / Deferred Capabilities` and fill Affected subprojects in project-plan.md); (b) include the frontend, run `/screen-inventory phase-03-videos` and add the CORS/ETag item to TD-03.
- **AMB-4** — TD-10 is decided as "A (real worker as a Compose service)", while its Recommendation says the test gets "full control of the worker lifecycle" to avoid contamination under the shared-database, run-in-band constraint. If the `video-worker` Compose service (TD-04) is up during `npm run test:e2e`, it consumes the same Redis queue with its own DB config and can pick up jobs enqueued by the test, processing them against the wrong database. Explicit choice: state how test jobs are isolated (test boots its own worker via `createApplicationContext` with a test queue prefix or Redis DB index, or the e2e run requires the dev worker to be stopped), as a revision of TD-10.

### Missing Decisions

- **MD-1** — Capabilities "Serviço de armazenamento de arquivos", "Upload de vídeos com suporte a arquivos de até 10GB" and "Reprodução via streaming" depend on an S3 client for `CreateMultipartUpload`, presigned `UploadPart`/`GetObject`, `CompleteMultipartUpload` and `HeadObject` (TD-02, TD-03, TD-05, TD-07, TD-10), and TD-03 requires the same client to work against MinIO (`S3_FORCE_PATH_STYLE`) and production S3. No TD names the library (e.g. `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` vs `minio` JS client), and every TD in this phase has `Libraries: —`. Explicit choice: run `/research` (or `/decide`) to add a TD, or append the library to TD-03 as a revision if the choice is considered implied.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (UI Inventory deferred; check not applicable.)

## Resolved Issues

_No issues resolved yet._
