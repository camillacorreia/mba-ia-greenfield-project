---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T13:23:51-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T13:23:30-03:00"
issues:
  - id: IC-1
    status: resolved
    resolved_by: phase-03-videos/TD-01
    summary: "TD-01 decision names @nestjs/bullmq + BullMQ but its Libraries field is empty"
  - id: AMB-1
    status: resolved
    resolved_by: phase-03-videos/TD-09
    summary: "Abandoned uploads: draft rows outlive the 1-day multipart abort, no rule given"
  - id: AMB-2
    status: resolved
    resolved_by: phase-03-videos/TD-03
    summary: "Which S3 endpoint signs URLs consumed inside containers (worker ffprobe, e2e)"
  - id: AMB-3
    status: resolved
    resolved_by: deferred_capability
    summary: "Phase 03 frontend boundary undefined: upload/player UI in or out of scope"
  - id: AMB-4
    status: resolved
    resolved_by: phase-03-videos/TD-10
    summary: "TD-10 worker test isolation: dev video-worker may consume test jobs"
  - id: MD-1
    status: resolved
    resolved_by: phase-03-videos/TD-03
    summary: "No TD picks the S3 client library for multipart, presign and HeadObject"
  - id: AMB-5
    status: resolved
    resolved_by: phase-03-videos/TD-09
    summary: "Video ownership undefined: video row belongs to the user or to the channel"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (UI Inventory deferred; check not applicable.)

## Resolved Issues

- **IC-1** — TD-01 decision names @nestjs/bullmq + BullMQ but its Libraries field is empty. resolved_by: phase-03-videos/TD-01 (Revision 2026-11-17: `**Libraries:** bullmq, @nestjs/bullmq, ioredis`; `ioredis` added because BullMQ 6 only loads it as an optional peer; Redis image pinned to `redis:8.10.3-alpine`).
- **AMB-1** — Abandoned uploads: draft rows outlive the 1-day multipart abort, no rule given. resolved_by: phase-03-videos/TD-09 (Revision 2026-11-17: BullMQ Job Scheduler on the TD-01 infrastructure marks `draft` rows older than 1 day as `failed` with reason `UPLOAD_EXPIRED` and tries `AbortMultipartUpload`).
- **AMB-2** — Which S3 endpoint signs URLs consumed inside containers (worker ffprobe, e2e). resolved_by: phase-03-videos/TD-03 (Revision 2026-11-17: client-facing URLs signed with `S3_PUBLIC_ENDPOINT`; worker and in-container test URLs signed with `S3_ENDPOINT`).
- **AMB-3** — Phase 03 frontend boundary undefined: upload/player UI in or out of scope. resolved_by: deferred_capability (clarification: backend-only phase; upload, player and download UI deferred to a future frontend slice, as phase-02-auth / phase-02-auth-frontend did. Three rows added to `context.md` `## Non-UI / Deferred Capabilities`, carrying the MinIO CORS with `ETag` exposed and the BFF bridging of the stream/download redirect as pending items of that slice. `**Affected subprojects:**` in `docs/project-plan.md` was not edited, since this stage does not write to project-plan.md).
- **AMB-4** — TD-10 worker test isolation: dev video-worker may consume test jobs. resolved_by: phase-03-videos/TD-10 (Revision 2026-11-17: the test boots its own processor via `createApplicationContext`/`TestingModule` with a test-only queue prefix and test buckets; Redis DB index alternative dropped).
- **MD-1** — No TD picks the S3 client library for multipart, presign and HeadObject. resolved_by: phase-03-videos/TD-03 (Revision 2026-11-17: `**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner`). Resolved as a TD-03 revision, the path the issue's explicit choice allows when the choice is considered implied, by explicit user answer; no new TD created.
- **AMB-5** — Video ownership undefined: video row belongs to the user or to the channel. resolved_by: phase-03-videos/TD-09 (Revision 2026-11-17: option (a), `Video` belongs to the channel via `channel_id` FK to `channels.id` with `ON DELETE CASCADE`; the owner check resolves the authenticated user's channel (1:1, created at registration in phase 02) and compares it with `video.channel_id`. Recorded as a TD-09 revision by explicit user answer).
