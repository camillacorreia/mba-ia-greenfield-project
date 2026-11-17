---
libs:
  bullmq:
    version: "^6.7.7"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-17T13:21:07-03:00"
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-17T13:21:07-03:00"
  ioredis:
    version: "^6.0.0"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-17T13:21:07-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1170.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-17T13:21:07-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1170.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-17T13:21:07-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T13:23:30-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this slice, pulled via Context7 and cross-checked against the npm registry on 2026-11-17. Runtime target: `node:25.6.0-slim` (Dockerfile.dev) and NestJS 11 (`@nestjs/common`/`@nestjs/core` `^11.0.1` in `nestjs-project/package.json`). Re-fetch when the underlying TD changes.

## Version compatibility check

| Package | Pinned | Latest on npm (2026-11-17) | Constraint checked |
|---------|--------|----------------------------|--------------------|
| `bullmq` | `^6.7.7` | 6.7.7 | `engines.node >=14.18.0`, OK for Node 25 |
| `@nestjs/bullmq` | `^12.0.2` | 12.0.2 | peer `@nestjs/common`/`@nestjs/core` `^10 \|\| ^11 \|\| ^12`, peer `bullmq` `^3 \|\| ^4 \|\| ^5 \|\| ^6`; OK for Nest 11 + BullMQ 6 |
| `ioredis` | `^6.0.0` | 6.0.0 | `engines.node >=20.0.0`; satisfies BullMQ's optional peer `ioredis >=5.0.0` and is the version BullMQ 6.7.7 itself develops against |
| `@aws-sdk/client-s3` | `^3.1170.0` | 3.1170.0 | `engines.node >=20.0.0` |
| `@aws-sdk/s3-request-presigner` | `^3.1170.0` | 3.1170.0 | `engines.node >=20.0.0`; keep on the same version line as `client-s3` |

The `@nestjs/bullmq` major (12) is decoupled from the Nest major: the 12.x line is the one that adds BullMQ 6 to its peer range and still accepts Nest 11.

## Container images (Compose)

| Service | Image | Verified |
|---------|-------|----------|
| `redis` | `redis:8.10.3-alpine` | `docker manifest inspect` OK (amd64, arm64 among others); latest stable 8.x on Docker Hub, 8.12 is still RC |
| `minio` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | `docker manifest inspect` OK (amd64, arm64) |
| `minio-init` (`mc`) | `pgsty/mc:RELEASE.2026-11-12T00-00-00Z` | `docker manifest inspect` OK (amd64, arm64) |

The official community-edition images are no longer published: `minio/minio` and `minio/mc` fail on any tag (Docker Hub denies the pull, `quay.io/minio/minio` has no manifest for the last release tag). The Pigsty fork (`pgsty/*`) keeps explicit release tags and the same S3 API, so nothing changes in the TD-03 env contract or in the `mc` commands used by `minio-init`. Alternatives considered and not chosen: `cgr.dev/chainguard/minio` (free tier only publishes `latest`, pin would be by digest) and `bitnamilegacy/minio` (frozen, no updates). Recorded as a TD-03 revision on 2026-11-17.

## bullmq

**Source:** `/taskforcesh/bullmq/v6.5.3` (Context7, closest indexed v6 docs). Maps to `phase-03-videos/TD-01` (queue), TD-09 (retries, `UnrecoverableError`, expiry scheduler) and TD-10 (test prefix).

### Redis connection in v6 (`ioredis` is no longer transitive)

BullMQ 6 made Redis drivers pluggable: `ioredis`, `redis` (node-redis) and Valkey Glide are all optional peer dependencies. The default connection path (passing `{ host, port }`) lazily `require('ioredis')` and throws `"BullMQ could not load the optional 'ioredis' package"` when it is missing. Hence `ioredis` is a direct dependency in TD-01.

```typescript
import { Queue } from 'bullmq';

const queue = new Queue('video-processing', {
  connection: { host: 'redis', port: 6379 }, // Compose service name, never localhost
  prefix: process.env.QUEUE_PREFIX,          // TD-10: test prefix isolates test jobs
});
```

Workers need `maxRetriesPerRequest: null` on ioredis connections. BullMQ sets it by default for connections it creates; if an `IORedis` instance is passed in manually, set it explicitly or BullMQ throws/warns.

### Idempotent enqueue (`jobId = videoId`)

A custom `jobId` must be unique within the queue; adding a job with an existing id is ignored. Avoid `:` and digit-only strings as custom ids (a UUID is fine).

```typescript
await queue.add('process-video', { videoId }, {
  jobId: videoId,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 }, // delay grows 2^(attempts-1) * delay
});
```

### Permanent failures (TD-09)

Throwing `UnrecoverableError` moves the job to failed without retries, overriding `attempts`.

```typescript
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('UNSUPPORTED_CODEC');
```

### Scheduled expiry of abandoned drafts (TD-09 revision)

The legacy repeatable API (`add(..., { repeat })`, `getRepeatableJobs`, `removeRepeatable*`, `Repeat`) was removed in v6. Use Job Schedulers; `upsertJobScheduler` is idempotent by scheduler id, so calling it on every worker boot is safe.

```typescript
await queue.upsertJobScheduler(
  'expire-draft-uploads',            // scheduler id
  { every: 60 * 60 * 1000 },          // or { pattern: '0 0 * * * *' } (cron with seconds)
  { name: 'expire-drafts', data: {}, opts: {} },
);
```

Other v6 breaking changes that matter here: `Queue.resume()` is async; `debounce` is gone in favor of deduplication (`deduplication: { id, ttl }`), which is a different mechanism from `jobId` dedupe and is not needed by TD-01.

## @nestjs/bullmq

**Source:** `/nestjs/bull` and the Nest 11 Queues technique (`/nestjs/docs.nestjs.com/__branch__11.0.0`). Maps to TD-01 and TD-04 (worker as `createApplicationContext`).

### Root and queue registration

Use `forRootAsync` to read the Redis connection from the namespaced config (phase-01 TD-01..03 convention).

```typescript
BullModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: { host: config.get('redis.host'), port: config.get('redis.port') },
    prefix: config.get('queue.prefix'),
  }),
}),
BullModule.registerQueue({
  name: 'video-processing',
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
}),
```

`RegisterQueueOptions` accepts every BullMQ `QueueOptions` key (`prefix`, `defaultJobOptions`, `connection`, ...). `sharedConnection` is deprecated. `backendFactory` is the hook for the BullMQ 6 pluggable backends (not needed with the default ioredis path).

### Producer and consumer

```typescript
@Injectable()
export class VideoQueueProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ffprobe/ffmpeg */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* final attempt → status failed */ }
}
```

The `@Processor` class must be a provider of a module loaded only by the worker entrypoint (`video-worker` service); the API module registers the queue and producer only, so the API process never consumes jobs. `@OnWorkerEvent` listeners on request-scoped processors are skipped.

## ioredis

**Source:** covered by the BullMQ connection guide above (`/taskforcesh/bullmq/v6.5.3`). Installed only because BullMQ 6 needs it at runtime; application code does not import it unless a shared `IORedis` instance is created by hand (then `maxRetriesPerRequest: null` is mandatory for workers).

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3`. Maps to TD-02 (multipart), TD-03 (layout, endpoints), TD-05 (worker reads), TD-07 (stream/download), TD-09 (abort on expiry), TD-10 (tests).

### Client configuration for MinIO and S3

The v2 `s3ForcePathStyle` became `forcePathStyle` in v3. A custom `endpoint` overrides the rule-based endpoint resolution. Per the TD-03 revision there are two clients: one on `S3_ENDPOINT` (server-side calls and URLs consumed inside Compose) and one on `S3_PUBLIC_ENDPOINT` (only for signing URLs delivered to clients outside the network).

```typescript
const internal = new S3Client({
  endpoint: config.s3.endpoint,          // http://minio:9000
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
});
const publicSigner = new S3Client({ ...sameConfig, endpoint: config.s3.publicEndpoint });
```

### Multipart commands used by the phase

`CreateMultipartUploadCommand` (returns `UploadId`), `UploadPartCommand` (presigned, see below), `CompleteMultipartUploadCommand` with `MultipartUpload: { Parts: [{ ETag, PartNumber }] }` (part numbers 1..10,000), `AbortMultipartUploadCommand` (TD-09 expiry; `NoSuchUpload` when the lifecycle rule already aborted it), and `HeadObjectCommand` (size check at complete and completion idempotency).

Browser part uploads need the bucket CORS rule to expose `ETag` (`ExposeHeaders: ["ETag"]`), otherwise the client cannot collect the part ETags for `CompleteMultipartUpload`. In this phase the uploads come from tests inside Compose (no CORS involved); the CORS rule is recorded as pending for the frontend slice in `context.md` `## Non-UI / Deferred Capabilities`.

### Checksums on presigned UploadPart

Recent v3 versions compute flexible checksums by default (`requestChecksumCalculation: WHEN_SUPPORTED`). For a presigned `UploadPart` where the body is not known at signing time, set `requestChecksumCalculation: 'WHEN_REQUIRED'` on the signing client so no checksum header is baked into the URL; otherwise the uploader would have to send a matching `x-amz-checksum-*` header.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (`packages/s3-request-presigner/README.md`). `getSignedUrl(client, command, { expiresIn })` works for any command, including `UploadPartCommand`; default `expiresIn` is 900s, so TD-02's 1h part URLs pass `expiresIn: 3600` explicitly.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const partUrl = await getSignedUrl(publicSigner,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });

const workerReadUrl = await getSignedUrl(internal,          // TD-05: consumed by ffprobe inside Compose
  new GetObjectCommand({ Bucket, Key }), { expiresIn: 900 });
```

The host is part of the SigV4 signature, so the URL cannot be rewritten after signing; choosing the signing client is the only way to pick the host (TD-03 revision).
