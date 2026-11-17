---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T13:26:34-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-17T13:26:25-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T13:26:25-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-17T12:56:47-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project/` o armazenamento de vídeos e thumbnails (MinIO/S3), o processamento em segundo plano por fila (BullMQ/Redis com um `video-worker` FFmpeg), o upload multipart direto ao storage de arquivos de até 10GB com pré-cadastro automático do vídeo como rascunho, a extração de duração e metadados com geração automática de thumbnail, a URL única por vídeo (`public_id`) e a reprodução via streaming e download por URLs pré-assinadas, de forma que upload de até 10GB, processamento automático, streaming e URLs únicas funcionem de ponta a ponta.

---

## Step Implementations

### SI-03.1 — Infra: dependências, Redis, MinIO e ffmpeg no ambiente

**Description:** Instala as bibliotecas da fase e sobe a infraestrutura nova no `nestjs-project/compose.yaml` (redis, minio, minio-init) com o ffmpeg na imagem de desenvolvimento, para que todos os SIs seguintes rodem contra serviços reais.

**Technical actions:**

1. Instalar no `nestjs-project` (dentro do container): `bullmq@^6.7.7`, `@nestjs/bullmq@^12.0.2`, `ioredis@^6.0.0`, `@aws-sdk/client-s3@^3.1170.0`, `@aws-sdk/s3-request-presigner@^3.1170.0`. O `ioredis` entra como dependência direta porque o BullMQ 6 o carrega como peer opcional (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Adicionar `ffmpeg` ao `apt install` do `Dockerfile.dev` (o pacote traz `ffmpeg` e `ffprobe`) e reconstruir a imagem. A mesma imagem atende `nestjs-api` e `video-worker`, e os testes rodam no `nestjs-api` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
3. Adicionar ao `compose.yaml` o serviço `redis` (`redis:8.10.3-alpine`, porta `6379`, healthcheck `redis-cli ping`) e o serviço `minio` (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `server /data --console-address ":9001"`, portas `9000` e `9001`, volume nomeado `minio-data`, `MINIO_ROOT_USER=${S3_ACCESS_KEY_ID:-streamtube}` e `MINIO_ROOT_PASSWORD=${S3_SECRET_ACCESS_KEY:-streamtube-secret}`, healthcheck de readiness validado contra a imagem durante a implementação) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
4. Adicionar o serviço one-shot `minio-init` (`pgsty/mc:RELEASE.2026-11-12T00-00-00Z`, `depends_on: minio: service_healthy`) executando `docker/minio-init.sh`: `mc alias set`, `mc mb --ignore-existing` de `videos`, `thumbnails`, `videos-test` e `thumbnails-test`, `mc anonymous set download` nos dois buckets de thumbnails, e `mc ilm import` com a regra `AbortIncompleteMultipartUpload` de 1 dia nos dois buckets de vídeo (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
5. Fazer `nestjs-api` depender de `redis` (`service_healthy`) e de `minio-init` (`service_completed_successfully`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `minio` com status `healthy` e `minio-init` com `exited (0)`
- `docker compose exec redis redis-cli ping` responde `PONG`
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` saem com código 0
- GET anônimo em `http://localhost:9000/thumbnails/inexistente.jpg` retorna `404`, e GET anônimo em `http://localhost:9000/videos/inexistente` retorna `403`
- `mc ilm export` no bucket `videos` mostra a regra de abort de multipart incompleto com 1 dia
- Rodar `docker compose up minio-init` uma segunda vez termina com código 0 sem alterar os buckets
- As suítes existentes continuam passando (`npm test -- --runInBand` e `npm run test:e2e`)

---

### SI-03.2 — Configuração de storage e fila, com ambiente isolado para testes

**Description:** Cria os namespaces de config `storage` e `queue` com o contrato de env da TD-03 e o isolamento de testes da TD-10, seguindo o padrão `registerAs` + Joi herdado da fase 01.

**Technical actions:**

1. Criar `src/config/storage.config.ts` com `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (convertido para boolean), `S3_BUCKET_VIDEOS` e `S3_BUCKET_THUMBNAILS` (per `phase-03-videos/TD-03`, `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/queue.config.ts` com `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) e `QUEUE_PREFIX` (default `streamtube`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-10`)
3. Estender `src/config/env.validation.ts`: `S3_ENDPOINT` e `S3_PUBLIC_ENDPOINT` uri obrigatórias, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_VIDEOS` e `S3_BUCKET_THUMBNAILS` obrigatórias, `S3_REGION` default `us-east-1`, `S3_FORCE_PATH_STYLE` em `'true' | 'false'` default `'false'`, mais as três variáveis de fila com default. Incluir `storageConfig` e `queueConfig` no `load` do `ConfigModule.forRoot` do `AppModule` (per `phase-01-configuracao-base/TD-02`)
4. Atualizar `.env.example` com os valores do Compose: `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_FORCE_PATH_STYLE=true`, buckets `videos` e `thumbnails`, credenciais iguais às do `minio`, `REDIS_HOST=redis`, `REDIS_PORT=6379`, `QUEUE_PREFIX=streamtube`
5. Criar `src/test/setup-test-env.ts`, registrado em `setupFiles` logo depois de `dotenv/config` no jest do `package.json` e em `test/jest-e2e.json`, que força `QUEUE_PREFIX=streamtube-test`, `S3_BUCKET_VIDEOS=videos-test`, `S3_BUCKET_THUMBNAILS=thumbnails-test` e `S3_PUBLIC_ENDPOINT` igual a `S3_ENDPOINT`, já que o cliente dos testes está dentro da rede do Compose (per `phase-03-videos/TD-03` revisão de assinatura, `phase-03-videos/TD-10` revisão de isolamento)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: variáveis S3 obrigatórias rejeitam ausência, defaults de `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`, `S3_REGION` e `S3_FORCE_PATH_STYLE` | `src/config/env.validation.integration-spec.ts` (estender) |

**Dependencies:** SI-03.1 (os valores do `.env.example` apontam para os serviços novos do Compose)

**Acceptance criteria:**

- Subir a aplicação sem `S3_BUCKET_VIDEOS` falha na validação Joi do bootstrap e o processo não sobe
- Com os valores do `.env.example`, a aplicação sobe e `GET /` continua retornando `200`
- Dentro de qualquer suíte Jest (unit, integration ou e2e), `QUEUE_PREFIX` vale `streamtube-test`, os buckets valem `videos-test` e `thumbnails-test` e `S3_PUBLIC_ENDPOINT` vale o mesmo que `S3_ENDPOINT`
- Fora do Jest, o `.env` de desenvolvimento continua com `QUEUE_PREFIX=streamtube` e os buckets de runtime

---

### SI-03.3 — Entidade Video, migration da tabela videos e geração do public_id

**Description:** Cria a entidade `Video` pertencendo ao canal, a migration da tabela `videos` e o gerador do `public_id`, base de todos os casos de uso da fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video`: `@Entity('videos')`, enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`), transformer `bigint → number` em `size_bytes`, `@ManyToOne(() => Channel, (channel) => channel.videos, { onDelete: 'CASCADE' })` com `@JoinColumn({ name: 'channel_id' })`, e os índices de `(channel_id)` e `(status, created_at)`. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos` em `Channel` (per `phase-03-videos/TD-09` revisão de dono, `phase-03-videos/TD-06`)
2. Criar `src/videos/public-id.util.ts` com `generatePublicId()` (`randomBytes(8).toString('base64url')`, sempre 11 caracteres) e `isValidPublicId(value)` (`^[A-Za-z0-9_-]{11}$`) (per `phase-03-videos/TD-06`)
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrar `VideosModule` no `AppModule`
4. Gerar a migration com `npm run migration:generate -- src/database/migrations/CreateVideos`, revisar enum, FK `ON DELETE CASCADE` e os três índices, e rodar `npm run migration:run`. A FK `channels.user_id` não muda
5. Atualizar os helpers de teste: `cleanAllTables` apaga `videos` antes de `channels`, `Video` entra nos arrays explícitos de entidades das specs de módulo e e2e, e a classe da migration nova entra em `src/database/migrations.integration-spec.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `draft`, unique `public_id`, enum rejeita valor fora da lista, `channel_id` not null, cascade ao apagar o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-id.util` | Unit: tamanho 11, alfabeto base64url, `isValidPublicId` aceita e rejeita | `src/videos/public-id.util.spec.ts` |
| `CreateVideos` migration | Integration: apply e revert incluindo `videos` e `videos_status_enum` | `src/database/migrations.integration-spec.ts` (estender) |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um vídeo sem informar `status` grava `draft`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Apagar um canal apaga os vídeos dele; apagar um usuário que ainda tem canal continua bloqueado pela FK da fase 02
- `npm run migration:revert` remove a tabela `videos` e o tipo `videos_status_enum`, e `npm run migration:run` recria os dois
- Todo `public_id` gerado tem 11 caracteres do alfabeto `[A-Za-z0-9_-]`

---

### SI-03.4 — StorageModule com cliente interno e assinador público

**Description:** Encapsula o MinIO/S3 num `StorageModule` com os dois clientes da TD-03 (interno e de assinatura pública), expondo operações em termos de vídeo e thumbnail para que nenhum outro módulo importe o SDK.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.constants.ts` com dois providers: `S3_INTERNAL_CLIENT` (`endpoint = S3_ENDPOINT`) e `S3_PUBLIC_SIGNER` (`endpoint = S3_PUBLIC_ENDPOINT`, `requestChecksumCalculation: 'WHEN_REQUIRED'` para não fixar header de checksum na URL de `UploadPart`), ambos com `forcePathStyle` e credenciais do `storageConfig`; exporta `StorageService` (per `phase-03-videos/TD-03`)
2. Criar `src/storage/storage.service.ts` com as operações de multipart no bucket de vídeos: `createVideoUpload(key, contentType)` devolve o `UploadId`, `presignUploadPart(key, uploadId, partNumber, expiresIn)` assina com o `S3_PUBLIC_SIGNER`, `completeVideoUpload(key, uploadId, parts)`, `abortVideoUpload(key, uploadId)` devolve `false` em `NoSuchUpload`, e `headVideo(key)` devolve o tamanho ou `null` (per `phase-03-videos/TD-02`)
3. Adicionar as operações de leitura e thumbnail: `presignVideoGet(key, { signer: 'public' | 'internal', expiresIn, responseContentType?, responseContentDisposition? })`, `putThumbnail(key, body)` com `ContentType: image/jpeg` e `thumbnailPublicUrl(key)` no formato `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{key}` (per `phase-03-videos/TD-03` revisão de assinatura, `phase-03-videos/TD-07`)
4. Criar `src/storage/storage.errors.ts` com `StorageNoSuchUploadError` e `StorageInvalidPartsError`, traduzidos a partir de `NoSuchUpload`, `InvalidPart`, `InvalidPartOrder` e `EntityTooSmall`, para que `VideosService` decida o código de domínio sem conhecer os nomes de erro do SDK

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real, buckets de teste): create → PUT nas URLs assinadas → complete → head; abort duas vezes; GET assinado com `Range` → 206; `putThumbnail` lido anonimamente; host de cada assinador | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação com `storageConfig` | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (MinIO e buckets), SI-03.2 (`storageConfig`)

**Acceptance criteria:**

- Um PUT com bytes na URL de `UploadPart` assinada responde `200` com header `ETag`
- O complete com os `ETag` coletados cria um objeto cujo tamanho no `HeadObject` é igual ao total enviado
- Um GET na URL de `GetObject` assinada com `Range: bytes=0-99` responde `206` com 100 bytes
- A URL do assinador público tem o host de `S3_PUBLIC_ENDPOINT` e a do cliente interno tem o host de `S3_ENDPOINT`
- Abortar um multipart já abortado termina sem exceção e devolve `false`
- Depois de `putThumbnail`, um GET anônimo em `thumbnailPublicUrl(key)` responde `200` com `Content-Type: image/jpeg`

---

### SI-03.5 — Fila video-processing e producer idempotente

**Description:** Conecta a API ao Redis via `@nestjs/bullmq` e registra a fila `video-processing` com o producer de `process-video`, sem nenhum consumer no processo da API.

**Technical actions:**

1. Criar `src/queue/bull-root.options.ts` com `bullRootOptions(queueConfig)` (`connection: { host, port }`, `prefix: QUEUE_PREFIX`) e registrar `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: bullRootOptions })` no `AppModule`. A mesma função será reaproveitada pelo worker (per `phase-03-videos/TD-01`, `phase-03-videos/TD-10`)
2. Criar `src/video-processing/video-processing.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `EXPIRE_DRAFTS_JOB = 'expire-drafts'` e `EXPIRE_DRAFTS_SCHEDULER_ID = 'expire-draft-uploads'`, conforme `### Events/Messages`
3. Criar `src/video-processing/video-processing-queue.module.ts` com `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } } })`, exportando a fila e o producer
4. Criar `src/video-processing/video-processing.producer.ts` com `VideoProcessingProducer.enqueueProcessing(videoId)` chamando `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId })` (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real, prefixo de teste): job com `jobId = videoId`, `attempts: 3` e backoff exponencial; dois enqueues do mesmo id geram um job | `src/video-processing/video-processing.producer.integration-spec.ts` |
| `VideoProcessingQueueModule` | Unit: compilação com `queueConfig` | `src/video-processing/video-processing-queue.module.spec.ts` |

**Dependencies:** SI-03.1 (Redis), SI-03.2 (`queueConfig`)

**Acceptance criteria:**

- `enqueueProcessing(videoId)` deixa um job `process-video` com `data = { videoId }` acessível por `queue.getJob(videoId)`
- Chamar `enqueueProcessing` duas vezes com o mesmo id mantém um único job na fila
- As chaves do job ficam sob o prefixo `streamtube-test` quando a chamada vem de um teste
- Com só a API rodando, um job enfileirado continua em `waiting`, porque a API não registra consumer
- A aplicação sobe conectada ao Redis e `GET /` continua retornando `200`

---

### SI-03.6 — Transições de status do vídeo e lookup do canal do usuário

**Description:** Concentra no `VideosModule` as leituras e transições guardadas de status da TD-09, e adiciona ao `ChannelsService` a busca do canal pelo usuário, que é a base do owner check.

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId): Promise<Channel | null>` em `src/channels/channels.service.ts` (per `phase-03-videos/TD-09` revisão de dono)
2. Criar `src/videos/video-lifecycle.service.ts` com `VideoLifecycleService` (exportado pelo `VideosModule`): `findById`, `findByPublicId`, `findExpiredDrafts(cutoff)` e as transições `markProcessing(id)` (`WHERE status = 'draft'`, zera `upload_id`), `markReady(id, metadata)` (`WHERE status IN ('draft', 'processing')`) e `markFailed(id, reason, fromStatuses)`. Cada transição é um único `UPDATE` condicional e devolve se alguma linha mudou (per `phase-03-videos/TD-09`)
3. Criar `src/videos/video-metadata.types.ts` com `VideoMetadata` (`duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_key`) e o tipo `VideoFailureReason` com os valores de `### Error Catalog → Failure reasons`
4. Fazer `VideosModule` importar `ChannelsModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoLifecycleService` | Integration: cada transição a partir de cada status (aceita ou no-op), `upload_id` zerado em `markProcessing`, `findExpiredDrafts` respeitando o corte e o status | `src/videos/video-lifecycle.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: usuário com canal e usuário inexistente | `src/channels/channels.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.3 (entidade `Video`)

**Acceptance criteria:**

- `markProcessing` num vídeo em `draft` grava `processing`, zera `upload_id` e devolve `true`; num vídeo em `ready` devolve `false` sem mudar a linha
- `markReady` num vídeo em `failed` devolve `false` e mantém `failure_reason`
- `markFailed(id, 'UPLOAD_EXPIRED', ['draft'])` num vídeo em `processing` devolve `false`
- `findExpiredDrafts(cutoff)` devolve só vídeos em `draft` com `created_at` anterior ao corte
- `findByUserId` devolve o canal criado no cadastro e `null` para um id sem canal

---

### SI-03.7 — Endpoint POST /videos (início do upload e rascunho)

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated; o rascunho é criado no canal do próprio usuário (`### Authorization Matrix`)

**Description:** Pré-cadastra o vídeo como rascunho e abre o multipart upload no storage numa única chamada, devolvendo o `public_id` e o plano de partes para o cliente enviar os bytes direto ao storage.

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` as exceções `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 413), `UnsupportedVideoFormatException` (`UNSUPPORTED_VIDEO_FORMAT`, 415) e `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404), com as mensagens de `### Error Catalog`
2. Criar `src/videos/dto/initiate-upload.dto.ts` (`filename`, `size`, `content_type` conforme `#### Validation Rules — Upload de vídeos`) e `src/videos/dto/initiate-upload-response.dto.ts` (`public_id`, `status`, `part_size`, `part_count`)
3. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, dto)`: valida tamanho ≤ `10737418240` e allowlist `video/mp4` / `video/webm`, resolve o canal com `ChannelsService.findByUserId`, gera o `id` com `randomUUID()`, chama `StorageService.createVideoUpload(id, content_type)`, grava o rascunho com `generatePublicId()` (até 5 tentativas em violação de unicidade de `public_id`, no mesmo padrão do `ChannelsService`) e, se o insert falhar de vez, aborta o multipart como compensação. `part_count = ceil(size / 104857600)` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
4. Criar `src/videos/videos.controller.ts` com `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`, `@Controller('videos')` e `@Post()` + `@HttpCode(201)` usando `@CurrentUser()`; documentar `201`, `400`, `401`, `404`, `413` e `415` com `@ApiOperation` e `@ApiResponse` referenciando `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01`)
5. Fazer `VideosModule` importar `StorageModule` e registrar `VideosController` e `VideosService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: 413, 415, canal ausente, retry de `public_id` em violação de unicidade, abort de compensação quando o insert falha, cálculo de `part_count` (múltiplo exato, resto, 10 GiB) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (Postgres + MinIO): linha em `draft` com `channel_id` e `upload_id`, multipart existente no storage | `src/videos/videos.service.integration-spec.ts` |

Os cenários E2E (supertest) desta rota ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.4 (`StorageService`), SI-03.6 (`ChannelsService.findByUserId` e `VideosModule` com canal)

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", size: 5000000, content_type: "video/mp4" }` retorna `201` com `public_id` de 11 caracteres, `status: "draft"`, `part_size: 104857600` e `part_count: 1`
- `POST /videos` com `size: 10737418240` retorna `201` com `part_count: 103`
- `POST /videos` com `size: 10737418241` retorna `413` com `error: "VIDEO_TOO_LARGE"` e nenhuma linha é criada em `videos`
- `POST /videos` com `content_type: "video/quicktime"` retorna `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
- `POST /videos` sem `filename` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- O rascunho criado tem `channel_id` igual ao canal do usuário autenticado e um `upload_id` aceito pelo storage

---

### SI-03.8 — Endpoint POST /videos/:publicId/upload/part-urls (URLs de envio das partes)

**Route:** POST /videos/:publicId/upload/part-urls
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (canal do vídeo); outro canal recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Emite as URLs pré-assinadas de `UploadPart` (1h, re-solicitáveis) para o dono de um rascunho, e introduz o owner check que as demais rotas `/videos/:publicId` reaproveitam.

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` as exceções `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotDraftException` (`VIDEO_NOT_DRAFT`, 409) e `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400)
2. Criar `src/videos/dto/request-part-urls.dto.ts` (`part_numbers` com `@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(10000)`, `@ArrayUnique`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) e `src/videos/dto/part-urls-response.dto.ts` (`parts: { part_number, url }[]`, `expires_in`)
3. Adicionar `VideosService.findOwnedVideo(userId, publicId)`: `publicId` fora de `isValidPublicId`, inexistente ou de outro canal lançam `VideoNotFoundException` (per `phase-03-videos/TD-09` revisão de dono, `phase-03-videos/TD-06`)
4. Adicionar `VideosService.requestPartUrls(userId, publicId, dto)`: exige `draft`, rejeita parte acima de `ceil(size_bytes / 104857600)` e assina cada parte com `StorageService.presignUploadPart(..., 3600)` na ordem pedida (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
5. Adicionar ao `VideosController` o handler `@Post(':publicId/upload/part-urls')` com `@HttpCode(200)` e documentação OpenAPI de `200`, `400`, `401`, `404` e `409`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedVideo` / `requestPartUrls` | Unit: `publicId` malformado, vídeo de outro canal, vídeo fora de `draft`, parte acima de `part_count`, ordem das partes devolvidas | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.requestPartUrls` | Integration (Postgres + MinIO): a URL devolvida aceita o PUT de uma parte e responde com `ETag` | `src/videos/videos.service.integration-spec.ts` (estender) |

Os cenários E2E (supertest) desta rota ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.7 (rascunho criado por `POST /videos`)

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` com `{ part_numbers: [1] }` num rascunho próprio retorna `200` com `parts[0].part_number = 1`, `url` no host de `S3_PUBLIC_ENDPOINT` e `expires_in: 3600`
- Um PUT de bytes nessa `url` é aceito pelo storage e devolve `ETag`
- Com `part_count = 1`, `{ part_numbers: [2] }` retorna `400` com `error: "INVALID_PART_NUMBER"`
- O mesmo pedido feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, igual a um `publicId` inexistente como `abc`
- Num vídeo em `processing`, a rota retorna `409` com `error: "VIDEO_NOT_DRAFT"`
- `{ part_numbers: [] }` e `{ part_numbers: [1, 1] }` retornam `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (fechamento e enfileiramento)

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (canal do vídeo); outro canal recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Fecha o multipart, confere o tamanho real contra o declarado e dispara o processamento assíncrono, seguindo a ordem enqueue idempotente antes da transição `draft → processing` fixada na TD-01.

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` as exceções `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) e `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422)
2. Criar `src/videos/dto/complete-upload.dto.ts` com `parts` validado em profundidade (`@ValidateNested({ each: true })`, `@Type(() => UploadPartDto)`, `UploadPartDto` com `part_number` inteiro ≥ 1 e `etag` não vazia) e `src/videos/dto/complete-upload-response.dto.ts` (`public_id`, `status`)
3. Adicionar `VideosService.completeUpload(userId, publicId, dto)`: owner check + `draft`; `StorageService.completeVideoUpload` com as partes ordenadas por `part_number`; `StorageInvalidPartsError` vira `INVALID_UPLOAD_PARTS`; `StorageNoSuchUploadError` cai no `headVideo` e só segue se o objeto existir (retry de um complete anterior); tamanho diferente de `size_bytes` chama `markFailed(id, 'UPLOAD_SIZE_MISMATCH', ['draft'])` e lança `UPLOAD_SIZE_MISMATCH`; caso contrário `VideoProcessingProducer.enqueueProcessing(id)` e depois `VideoLifecycleService.markProcessing(id)` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-10`)
4. Adicionar ao `VideosController` o handler `@Post(':publicId/upload/complete')` com `@HttpCode(202)` e documentação OpenAPI de `202`, `400`, `401`, `404`, `409` e `422`
5. Fazer `VideosModule` importar `VideoProcessingQueueModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: enqueue antes de `markProcessing`, partes inválidas, caminho `NoSuchUpload` com e sem objeto, divergência de tamanho marca `failed`, vídeo fora de `draft` | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + Redis com prefixo de teste): upload real da fixture pelas URLs assinadas, complete, linha em `processing` com `upload_id` nulo e job `process-video` com `jobId = id` | `src/videos/videos.service.integration-spec.ts` (estender) |

Os cenários E2E (supertest) desta rota ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.5 (producer), SI-03.8 (URLs das partes e owner check)

**Acceptance criteria:**

- Depois de enviar todas as partes, `POST /videos/:publicId/upload/complete` com os `ETag` retorna `202` com `{ public_id, status: "processing" }` e a linha fica em `processing` com `upload_id` nulo
- Existe na fila um job `process-video` com `jobId` igual ao `id` interno do vídeo
- Repetir o complete retorna `409` com `error: "VIDEO_NOT_DRAFT"` e a fila continua com um único job para o vídeo
- Um complete com `etag` errado retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua em `draft`
- Declarar `size` maior que os bytes enviados faz o complete retornar `422` com `error: "UPLOAD_SIZE_MISMATCH"`, a linha fica em `failed` com `failure_reason = UPLOAD_SIZE_MISMATCH` e o objeto continua no bucket
- Um complete de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.10 — MediaInspector (ffprobe/ffmpeg) e política de formatos

**Description:** Implementa a leitura remota de metadados e a extração de um frame com `execFile` direto em `ffprobe`/`ffmpeg`, mais a política pura de container e codec da TD-08, com fixtures de mídia pequenas commitadas.

**Technical actions:**

1. Gerar uma vez com ffmpeg e commitar em `nestjs-project/test/fixtures/media/`: `sample-h264-aac.mp4`, `sample-vp9-opus.webm`, `sample-mpeg4.mp4` (vídeo MPEG-4 Part 2, fora da allowlist) e `not-a-video.mp4` (bytes de texto), todos com 1 a 2s e menos de ~100KB, registrando os comandos de geração em `test/fixtures/media/README.md` (per `phase-03-videos/TD-10`)
2. Criar `src/video-processing/media-inspector.service.ts` com `MediaInspector.probe(url)`: `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url])` com timeout, convertido em `ProbeResult` (`formatName`, `durationSeconds`, `video: { codec, width, height } | null`, `audio: { codec } | null`); saída diferente de zero vira `MediaUnreadableError` (per `phase-03-videos/TD-05`)
3. Adicionar `MediaInspector.extractFrame(url, atSeconds)`: `execFile('ffmpeg', ['-ss', ..., '-i', url, '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'])` com `encoding: 'buffer'` e `maxBuffer` dimensionado, devolvendo o JPEG em memória. A dimensão final do JPEG fica a critério da implementação (per `phase-03-videos/TD-05`)
4. Criar `src/video-processing/codec-policy.ts` com `checkPlayability(contentType, probe)` devolvendo `ok` ou um dos motivos `INVALID_MEDIA`, `UNSUPPORTED_CONTAINER`, `UNSUPPORTED_CODEC` conforme `### Error Catalog → Failure reasons`, e `thumbnailTimestamp(durationSeconds)` = `min(durationSeconds * 0.1, 5)` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `codec-policy` | Unit: cada combinação aceita da allowlist, áudio ausente aceito, container divergente, sem stream de vídeo e duração zero, limite de 5s no timestamp | `src/video-processing/codec-policy.spec.ts` |
| `MediaInspector` (parse) | Unit: conversão de JSON de ffprobe capturado (ordem dos streams, áudio ausente, duração em string) | `src/video-processing/media-inspector.service.spec.ts` |
| `MediaInspector` | Integration (ffprobe/ffmpeg reais no container, fixtures lidas por URL pré-assinada interna do MinIO): `probe` e `extractFrame` nas fixtures válidas, `MediaUnreadableError` em `not-a-video.mp4` | `src/video-processing/media-inspector.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (ffmpeg na imagem), SI-03.4 (URL pré-assinada interna)

**Acceptance criteria:**

- `probe` de `sample-h264-aac.mp4` lido por URL pré-assinada interna devolve `formatName` contendo `mp4`, vídeo `h264`, áudio `aac` e duração maior que zero
- `extractFrame` da mesma fixture devolve bytes que começam com `FF D8 FF` (JPEG)
- `checkPlayability('video/mp4', ...)` para `sample-mpeg4.mp4` devolve `UNSUPPORTED_CODEC`, e `checkPlayability('video/webm', ...)` para `sample-vp9-opus.webm` devolve `ok`
- `checkPlayability('video/webm', ...)` para `sample-h264-aac.mp4` devolve `UNSUPPORTED_CONTAINER`
- `probe` de `not-a-video.mp4` lança `MediaUnreadableError` sem devolver resultado parcial

---

### SI-03.11 — Processamento do vídeo no worker (job process-video)

**Description:** Implementa o consumer de `process-video`, que extrai metadados, valida o formato, gera a thumbnail e leva o vídeo a `ready` ou `failed` com a política de falha permanente versus transitória da TD-09.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` com `process(videoId)`: ignora vídeo inexistente, `ready` ou `failed`; assina um GET interno (`signer: 'internal'`, 900s); roda `probe` e `checkPlayability`; motivo permanente (incluindo `MediaUnreadableError` como `INVALID_MEDIA`) chama `markFailed(id, reason, ['draft', 'processing'])` e lança `UnrecoverableError(reason)`; caso válido extrai o frame em `thumbnailTimestamp`, grava com `putThumbnail('{id}.jpg', ...)` e chama `markReady` com `VideoMetadata`. Qualquer outro erro é relançado como transitório (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
2. Criar `src/video-processing/video.processor.ts` com `VideoProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)`, `extends WorkerHost`) despachando por `job.name` (`process-video` para `VideoProcessingService.process`; nome desconhecido lança `UnrecoverableError`) e `@OnWorkerEvent('failed')` que, na última tentativa de um erro não permanente, chama `markFailed(id, 'PROCESSING_FAILED', ['draft', 'processing'])` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-09`)
3. Criar `src/video-processing/video-processing.module.ts`, carregado só pelo worker: importa `VideosModule`, `StorageModule` e `VideoProcessingQueueModule`, e declara `MediaInspector`, `VideoProcessingService` e `VideoProcessor`. O `AppModule` não importa este módulo (per `phase-03-videos/TD-04`)
4. Criar `src/test/start-test-processor.ts`, que sobe um `TestingModule` com config de teste, TypeORM, `BullModule.forRootAsync(bullRootOptions)` e `VideoProcessingModule` e devolve a função de encerramento; é o processor que os testes de integração e e2e usam com o prefixo `streamtube-test` (per `phase-03-videos/TD-10` revisão de isolamento)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: no-op em `ready`/`failed`, cada motivo permanente vira `markFailed` + `UnrecoverableError`, erro transitório relançado, chave `{id}.jpg` e timestamp da thumbnail | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessor` | Unit: despacho por nome de job, handler `failed` só na última tentativa e só para erro não permanente | `src/video-processing/video.processor.spec.ts` |
| Pipeline `process-video` | Integration (Postgres + MinIO + Redis + ffmpeg, processor do teste): MP4 h264/aac e WebM vp9/opus chegam a `ready` com thumbnail; MPEG-4 Part 2 e `not-a-video.mp4` chegam a `failed` com uma tentativa | `src/video-processing/video-processing.integration-spec.ts` |

**Dependencies:** SI-03.5 (fila), SI-03.6 (transições de status), SI-03.10 (`MediaInspector` e política de formatos)

**Acceptance criteria:**

- Um `process-video` para um MP4 h264/aac enviado leva o vídeo a `ready` com `duration_seconds > 0`, `width` e `height` iguais aos da fixture, `video_codec = h264`, `audio_codec = aac` e `thumbnail_key = {id}.jpg`
- Um GET anônimo na URL pública da thumbnail gerada responde `200` com `Content-Type: image/jpeg`
- Um MP4 MPEG-4 Part 2 termina em `failed` com `failure_reason = UNSUPPORTED_CODEC` depois de uma única tentativa, e o objeto original continua no bucket de vídeos
- `not-a-video.mp4` termina em `failed` com `failure_reason = INVALID_MEDIA`
- Um erro transitório que persiste nas 3 tentativas deixa o vídeo em `failed` com `PROCESSING_FAILED`; um erro que some na segunda tentativa termina em `ready`
- Um job duplicado para um vídeo já em `ready` não altera a linha (`updated_at` igual)

---

### SI-03.12 — Expiração de rascunhos abandonados (job expire-drafts)

**Description:** Implementa a transição `draft → failed` com `UPLOAD_EXPIRED` para uploads abandonados há mais de 1 dia, agendada por Job Scheduler do BullMQ no worker, alinhada à regra de lifecycle que aborta multiparts incompletos.

**Technical actions:**

1. Criar `src/video-processing/draft-expiry.service.ts` com `DraftExpiryService.expireDrafts(now = new Date())`: busca `findExpiredDrafts(now - 24h)` e, para cada vídeo, chama `StorageService.abortVideoUpload(id, upload_id)` quando houver `upload_id` (resposta `NoSuchUpload` não é erro) e `markFailed(id, 'UPLOAD_EXPIRED', ['draft'])`. Erro num item é logado e não interrompe os demais; devolve quantos vídeos expiraram (per `phase-03-videos/TD-09` revisão de expiração)
2. Criar `src/video-processing/draft-expiry.scheduler.ts` com `DraftExpiryScheduler implements OnApplicationBootstrap`, que chama `queue.upsertJobScheduler(EXPIRE_DRAFTS_SCHEDULER_ID, { every: 3600000 }, { name: EXPIRE_DRAFTS_JOB, data: {} })` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-01`)
3. Estender o despacho do `VideoProcessor` com `expire-drafts` para `DraftExpiryService.expireDrafts()` e registrar `DraftExpiryService` e `DraftExpiryScheduler` no `VideoProcessingModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DraftExpiryService` | Unit: `NoSuchUpload` tolerado, falha num item não interrompe os outros, rascunho sem `upload_id` | `src/video-processing/draft-expiry.service.spec.ts` |
| `DraftExpiryService` | Integration (Postgres + MinIO): rascunho com multipart real e `created_at` 25h atrás vai para `failed` e o multipart some; rascunho de 1h e vídeo antigo em `processing` ficam intactos | `src/video-processing/draft-expiry.service.integration-spec.ts` |
| `DraftExpiryScheduler` | Integration (Redis, prefixo de teste): dois bootstraps seguidos deixam um único scheduler `expire-draft-uploads` com `every: 3600000` | `src/video-processing/draft-expiry.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.11 (`VideoProcessor` e `VideoProcessingModule`)

**Acceptance criteria:**

- Um rascunho com `created_at` há 25h vai para `failed` com `failure_reason = UPLOAD_EXPIRED`, e um `ListParts` no `upload_id` dele passa a responder `NoSuchUpload`
- Um rascunho criado há 1h continua em `draft` com o multipart aberto
- Um vídeo em `processing` criado há 25h não é alterado
- Um rascunho expirado cujo multipart já foi abortado pela regra de lifecycle também termina em `failed` com `UPLOAD_EXPIRED`
- Rodar `expireDrafts` duas vezes seguidas não altera nada na segunda execução
- Com o worker no ar, a fila tem exatamente um Job Scheduler `expire-draft-uploads`, mesmo depois de reinícios

---

### SI-03.13 — Entrypoint do worker e serviço video-worker no Compose

**Description:** Sobe o consumer como processo Nest separado (`createApplicationContext`) no mesmo codebase, com o serviço `video-worker` no Compose padrão, consumindo a fila desde o `docker compose up -d` e compartilhando entidade, migrations e validação de env com a API. O critério de aceite da fase exige que storage, fila e worker subam via Compose junto com o backend, então o worker é tratado como infraestrutura de processamento, enquanto o servidor HTTP da API continua subindo só sob pedido.

**Technical actions:**

1. Extrair `src/database/typeorm-options.ts` com `buildTypeOrmOptions(dbConfig)` e usá-lo no `TypeOrmModule.forRootAsync` do `AppModule`, para que API e worker leiam a conexão de um único `databaseConfig` (convenção herdada da fase 01)
2. Criar `src/worker.module.ts` com `WorkerModule`: `ConfigModule.forRoot` com o mesmo `load` e `envValidationSchema` do `AppModule`, `TypeOrmModule.forRootAsync(buildTypeOrmOptions)`, `BullModule.forRootAsync(bullRootOptions)` e `VideoProcessingModule` (per `phase-03-videos/TD-04`)
3. Criar `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()` e log de prontidão, e adicionar ao `package.json` os scripts `start:worker` (`node dist/worker`, a partir do `npm run build`) e `start:worker:dev` (`nest start --watch --entryFile worker --path tsconfig.worker.json`) (per `phase-03-videos/TD-04`)
4. Criar `tsconfig.worker.json` estendendo `tsconfig.build.json` com `outDir: ./dist-worker`, para que o watch do worker e o `start:dev`/`build` da API não disputem o mesmo `dist/` no volume compartilhado (o `nest-cli.json` usa `deleteOutDir: true`, e um apagaria a saída do outro). Adicionar `/dist-worker` ao `.gitignore` e às exclusões do `tsconfig.json` e do ESLint. Confirmar via context7 que `nest start --path` resolve `outDir` e `entryFile` a partir do tsconfig informado
5. Adicionar o serviço `video-worker` ao `compose.yaml`, sem `profiles`: mesmo `build` (`Dockerfile.dev`) e volume `.:/home/node/app` do `nestjs-api`, `restart: unless-stopped`, `depends_on` com `db: service_healthy`, `redis: service_healthy` e `minio-init: service_completed_successfully`, e `command: sh -c "until [ -x node_modules/.bin/nest ]; do echo 'video-worker: aguardando node_modules, rode docker compose exec nestjs-api npm install'; sleep 5; done; exec npm run start:worker:dev"`. O laço cobre o clone recém-feito, em que o `node_modules` ainda não existe no volume até o `npm install` dentro do container, sem entrar em ciclo de crash e restart

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação com config, TypeORM, BullMQ e `VideoProcessingModule` | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.12 (`VideoProcessingModule` completo, com os dois jobs)

**Acceptance criteria:**

- `docker compose up -d` sobe o `video-worker` junto com `db`, `redis`, `minio`, `minio-init` e `nestjs-api`; o `video-worker` fica `running`, com log de worker pronto e sem porta HTTP exposta
- O `video-worker` só inicia depois de `db` e `redis` ficarem `healthy` e de `minio-init` terminar com código 0
- Num clone sem `node_modules`, o `video-worker` fica aguardando com a mensagem que orienta o `npm install`, e depois de `docker compose exec nestjs-api npm install` passa a consumir a fila sem nenhum comando manual no worker
- Se o processo principal do `video-worker` morrer, o container volta sozinho por `restart: unless-stopped`; `docker compose stop video-worker` o mantém parado
- Com o `video-worker` no ar, um upload completo feito pela API em runtime chega a `ready` sem nenhum processo extra
- Com só o `video-worker` consumindo, um job enfileirado com o prefixo `streamtube-test` continua em `waiting`
- Rodar `npm run start:dev` ou `npm run build` no `nestjs-api` com o `video-worker` no ar não derruba nem recompila o worker
- `npm run build` gera `dist/worker.js` e `npm run start:worker` sobe o worker a partir do build
- `GET /` da API continua retornando `200` depois da extração de `buildTypeOrmOptions`

---

### SI-03.14 — Endpoint GET /videos/:publicId (estado do vídeo)

**Route:** GET /videos/:publicId
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (canal do vídeo); outro canal recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Expõe ao dono o estado e os metadados do vídeo, que é como o cliente acompanha o processamento até `ready` ou `failed`; o spec E2E desta rota cobre o fluxo completo upload → complete → processamento → `ready` com o processor do teste.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` com os campos de `### API Contracts → GET /videos/:publicId` e `src/videos/video-response.mapper.ts` com `toVideoResponse(video, thumbnailUrlFor)`, que nunca expõe `id`, `channel_id` nem `upload_id` (per `phase-03-videos/TD-06`)
2. Adicionar `VideosService.getVideo(userId, publicId)` usando `findOwnedVideo` e `StorageService.thumbnailPublicUrl` para montar `thumbnail_url` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`)
3. Adicionar ao `VideosController` o handler `@Get(':publicId')` com documentação OpenAPI de `200`, `401` e `404`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `toVideoResponse` | Unit: `thumbnail_url` nulo sem `thumbnail_key`, ausência de `id`/`channel_id`/`upload_id`, `size_bytes` numérico, datas em ISO-8601 | `src/videos/video-response.mapper.spec.ts` |

Os cenários E2E (supertest) desta rota, incluindo o fluxo completo até `ready`, ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.8 (owner check), SI-03.11 (processor usado no fluxo completo)

**Acceptance criteria:**

- `GET /videos/:publicId` de um rascunho próprio retorna `200` com `status: "draft"`, `duration_seconds: null` e `thumbnail_url: null`, sem `id`, `channel_id` nem `upload_id` no corpo
- Depois de upload, complete e processamento, a mesma rota retorna `status: "ready"` com `duration_seconds`, `width`, `height`, `video_codec` e um `thumbnail_url` que responde `200` a um GET anônimo
- Um vídeo que falhou retorna `status: "failed"` com o `failure_reason` gravado
- O mesmo pedido feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Sem token, a rota retorna `401`

---

### SI-03.15 — Endpoint GET /videos/:publicId/stream (reprodução por streaming)

**Route:** GET /videos/:publicId/stream
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (canal do vídeo), só com `status = ready`; outro canal recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Redireciona o dono para uma URL pré-assinada do storage, que atende `Range` com `206`, entregando streaming progressivo sem que os bytes passem pela API.

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` a exceção `VideoNotReadyException` (`VIDEO_NOT_READY`, 409)
2. Adicionar `VideosService.getStreamUrl(userId, publicId)`: `findOwnedVideo`, exige `ready`, e devolve `StorageService.presignVideoGet(id, { signer: 'public', expiresIn: 3600, responseContentType: content_type })` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-03` revisão de assinatura)
3. Adicionar ao `VideosController` o handler `@Get(':publicId/stream')` com `@Redirect()` devolvendo `{ url, statusCode: 302 }`, e documentação OpenAPI de `302` (header `Location`), `401`, `404` e `409`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: `draft`, `processing` e `failed` lançam `VIDEO_NOT_READY`; `ready` assina com o assinador público, 3600s e o `content_type` do vídeo | `src/videos/videos.service.spec.ts` (estender) |

Os cenários E2E (supertest) desta rota ficam no spec gerado por `/plan-test-specs`; o spec pode semear um vídeo `ready` direto no banco e no bucket de teste, sem depender do worker.

**Dependencies:** SI-03.8 (owner check)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo próprio em `ready` retorna `302` com corpo vazio e `Location` no host de `S3_PUBLIC_ENDPOINT`, com `X-Amz-Expires=3600`
- Um GET na URL do `Location` com `Range: bytes=0-1023` responde `206` com `Content-Range: bytes 0-1023/{size_bytes}` e `Content-Type` igual ao `content_type` do vídeo
- Num vídeo em `processing`, a rota retorna `409` com `error: "VIDEO_NOT_READY"`
- O mesmo pedido feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Sem token, a rota retorna `401`

---

### SI-03.16 — Endpoint GET /videos/:publicId/download (download do vídeo)

**Route:** GET /videos/:publicId/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (canal do vídeo), só com `status = ready`; outro canal recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Igual ao stream, mas a URL pré-assinada força `Content-Disposition: attachment` com o nome original, para o navegador baixar o arquivo em vez de reproduzir.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` com `attachmentDisposition(filename)`: `attachment; filename="..."` com fallback ASCII e `filename*=UTF-8''...` quando houver caracteres fora de ASCII, removendo aspas, barras invertidas e quebras de linha
2. Adicionar `VideosService.getDownloadUrl(userId, publicId)`: mesmo caminho de `getStreamUrl`, passando `responseContentDisposition: attachmentDisposition(original_filename)` (per `phase-03-videos/TD-07`)
3. Adicionar ao `VideosController` o handler `@Get(':publicId/download')` com `@Redirect()` e documentação OpenAPI de `302` (header `Location`), `401`, `404` e `409`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `attachmentDisposition` | Unit: nome ASCII, nome com acento (`filename*`), aspas e CRLF removidos | `src/videos/content-disposition.util.spec.ts` |
| `VideosService.getDownloadUrl` | Unit: `VIDEO_NOT_READY` fora de `ready`, disposition repassada ao assinador | `src/videos/videos.service.spec.ts` (estender) |

Os cenários E2E (supertest) desta rota ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.15 (`VideoNotReadyException` e caminho de assinatura de leitura)

**Acceptance criteria:**

- `GET /videos/:publicId/download` de um vídeo próprio em `ready` retorna `302`, e o GET no `Location` responde `200` com `Content-Disposition: attachment; filename="aula.mp4"` e `Content-Length` igual a `size_bytes`
- Para `original_filename = "vídeo final.mp4"`, o `Content-Disposition` servido traz `filename*=UTF-8''v%C3%ADdeo%20final.mp4`
- Num vídeo em `draft`, a rota retorna `409` com `error: "VIDEO_NOT_READY"`
- O mesmo pedido feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Sem token, a rota retorna `401`

---

### SI-03.17 — OpenAPI exportado, api.http e CLAUDE.md com a seção de vídeos

**Description:** Fecha a fase alinhando contrato exportado e documentação ao código que realmente foi implementado: `openapi.json`, exemplos em `api.http` e os dois `CLAUDE.md` (raiz e `nestjs-project/`).

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` (e o `src/metadata.ts` do plugin, se o build o atualizar) e conferir as seis rotas da tag `videos` com seus códigos de erro referenciando `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)
2. Adicionar a `nestjs-project/api.http` a seção de vídeos (início, URLs das partes, complete, estado, stream, download), com variáveis capturadas das respostas como já é feito no login
3. Atualizar `nestjs-project/CLAUDE.md` a partir do código final: em "Environment Startup Verification", deixar claro que subir o ambiente inclui o `video-worker` (infraestrutura de processamento que consome a fila, sobe no `docker compose up -d` padrão) e que o servidor HTTP da API (`npm run start:dev`) continua só sob pedido explícito; listar os serviços novos (`redis`, `minio` em 9000/9001, `minio-init`, `video-worker`) com seus checks de prontidão (incluindo o log de worker pronto e o aviso de `node_modules` ausente), o `dist-worker/` separado do `dist/`, ffmpeg na imagem, `setup-test-env.ts` na seção de Jest com prefixo e buckets de teste, e uma seção de vídeos descrevendo módulos (`VideosModule`, `StorageModule`, `VideoProcessingQueueModule`, `VideoProcessingModule`, `WorkerModule`), fluxo de upload, ciclo de status e variáveis de ambiente
4. Atualizar o `CLAUDE.md` da raiz: Message Queue deixa de ser `TBD` e passa a BullMQ sobre Redis, o Video Worker passa a ser o serviço `video-worker` do mesmo codebase, e uma seção de vídeos no fim resume o fluxo implementado e onde cada parte mora

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `exportSpec` | Integration: documento exportado contém os paths `/videos`, `/videos/{publicId}`, `/videos/{publicId}/upload/part-urls`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}/stream` e `/videos/{publicId}/download` | `src/openapi-export.integration-spec.ts` (estender) |

**Dependencies:** SI-03.13, SI-03.14, SI-03.16 (todo o código da fase pronto, para a documentação refletir o estado real)

**Acceptance criteria:**

- `openapi.json` commitado lista as seis rotas de vídeo, com `302` e header `Location` em stream e download e as respostas de erro do `### Error Catalog`
- Cada requisição da seção de vídeos do `api.http`, executada em ordem contra o ambiente com `video-worker` no ar, retorna o status documentado em `### API Contracts`
- Os comandos de verificação citados no `nestjs-project/CLAUDE.md` (prontidão de Redis e MinIO, log de worker pronto) executam com sucesso num ambiente recém-criado com `docker compose up -d`
- O `nestjs-project/CLAUDE.md` diz que "subir o ambiente" inclui o `video-worker` e mantém o servidor HTTP da API fora desse passo
- O `CLAUDE.md` da raiz não menciona mais a fila como `TBD`, e todos os nomes de módulo, serviço e variável citados nas seções de vídeo existem no código

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Interno. Base das chaves no storage (`phase-03-videos/TD-03`) e do `jobId` na fila (`phase-03-videos/TD-01`). Nunca exposto na API |
| public_id | varchar(11) | unique, not null | ID público de 11 caracteres base64url, gerado na criação do rascunho (`phase-03-videos/TD-06`). Usado em todas as rotas como `:publicId` |
| channel_id | uuid | FK → `channels.id` `ON DELETE CASCADE`, not null | Dono do vídeo é o canal, sem coluna `user_id` (`phase-03-videos/TD-09`, revisão de 2026-11-17) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` | Ciclo de vida único `draft → processing → ready / failed`, mais `draft → failed` para upload abandonado (`phase-03-videos/TD-09`) |
| failure_reason | varchar(50) | nullable | Preenchido só quando `status = failed`. Valores em `### Error Catalog → Failure reasons` |
| original_filename | varchar(255) | not null | Nome do arquivo informado no início do upload; usado no `Content-Disposition` do download |
| content_type | varchar(50) | not null | `video/mp4` ou `video/webm` (`phase-03-videos/TD-08`) |
| size_bytes | bigint | not null | Tamanho declarado no início do upload, ≤ `10737418240` (10 GiB, `phase-03-videos/TD-02`). Transformer da coluna converte para `number` (valor sempre < 2^53) |
| upload_id | text | nullable | `UploadId` do multipart S3. Preenchido na criação do rascunho, zerado na transição para `processing`. Usado pela expiração para `AbortMultipartUpload` (`phase-03-videos/TD-09`) |
| duration_seconds | double precision | nullable | Extraído pelo ffprobe (`phase-03-videos/TD-05`) |
| width | integer | nullable | Extraído pelo ffprobe |
| height | integer | nullable | Extraído pelo ffprobe |
| video_codec | varchar(50) | nullable | `codec_name` do stream de vídeo (ffprobe) |
| audio_codec | varchar(50) | nullable | `codec_name` do stream de áudio; null quando o arquivo não tem áudio |
| thumbnail_key | varchar(255) | nullable | Chave do JPEG no bucket `S3_BUCKET_THUMBNAILS`; null até o worker gerar a thumbnail |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn`. Base do corte de 1 dia da expiração de rascunhos |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, lado inverso `channel.videos`). A FK `channels.user_id` da fase 02 continua `ON DELETE NO ACTION` e não muda nesta fase.
**Indexes:** `(public_id)` unique, `(channel_id)`, `(status, created_at)` para a varredura de rascunhos expirados.
**Migration:** uma migration nova (`CreateVideos{timestamp}`) cria o enum `videos_status_enum`, a tabela `videos`, a FK e os três índices; o `down` remove na ordem inversa.

#### Storage layout (MinIO/S3)

| Bucket (env) | Acesso | Chave do objeto | Conteúdo |
|--------------|--------|-----------------|----------|
| `S3_BUCKET_VIDEOS` (`videos`; testes: `videos-test`) | privado | `{id}` | Arquivo original enviado por multipart. Mantido mesmo quando o processamento falha (`phase-03-videos/TD-09`) |
| `S3_BUCKET_THUMBNAILS` (`thumbnails`; testes: `thumbnails-test`) | leitura pública anônima | `{id}.jpg` | Thumbnail JPEG gerada pelo worker (`phase-03-videos/TD-05`) |

Buckets, política pública de `thumbnails` e a regra de lifecycle `AbortIncompleteMultipartUpload` de 1 dia em `videos` são criados pelo serviço one-shot `minio-init`, nunca pela aplicação (`phase-03-videos/TD-03`). A URL pública da thumbnail é `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{thumbnail_key}` (path-style).

### API Contracts

Todas as rotas abaixo exigem `Authorization: Bearer <access_token>` (guard global `JwtAuthGuard`, sem `@Public()`). O campo de identificação exposto é sempre `public_id`; o `id` UUID nunca aparece em request nem response (`phase-03-videos/TD-06`).

#### POST /videos (SI-03.7)

Inicia o upload: cria o rascunho e o multipart upload no storage (`phase-03-videos/TD-02`, `phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 a 255 caracteres
- size: integer, required — ≥ 1 (bytes declarados). Acima de `10737418240` cai em `VIDEO_TOO_LARGE`
- content_type: string, required — não vazio. Fora de `video/mp4` e `video/webm` cai em `UNSUPPORTED_VIDEO_FORMAT`

**Response 201:**
- public_id: string (11 caracteres base64url)
- status: `"draft"`
- part_size: integer — sempre `104857600` (100 MiB)
- part_count: integer — `ceil(size / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: quando o body falha na validação do DTO
- 401 Unauthorized: sem token ou token inválido
- 404 CHANNEL_NOT_FOUND: quando o usuário autenticado não tem canal
- 413 VIDEO_TOO_LARGE: quando `size` > `10737418240`
- 415 UNSUPPORTED_VIDEO_FORMAT: quando `content_type` não está na allowlist

---

#### POST /videos/:publicId/upload/part-urls (SI-03.8)

Emite URLs pré-assinadas de `UploadPart`, assinadas com `S3_PUBLIC_ENDPOINT` e válidas por 1h. Pode ser chamada quantas vezes for preciso enquanto o vídeo estiver em `draft` (`phase-03-videos/TD-02`, `phase-03-videos/TD-03`).

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 a 10000 itens, sem repetição, cada item ≥ 1. Item acima de `part_count` cai em `INVALID_PART_NUMBER`

**Response 200:**
- parts: array de `{ part_number: integer, url: string }`, na ordem pedida
- expires_in: integer — `3600` (segundos)

**Error responses:**
- 400 VALIDATION_ERROR: quando o body falha na validação do DTO
- 400 INVALID_PART_NUMBER: quando algum `part_numbers[i]` > `part_count` do vídeo
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de vídeo de outro canal
- 409 VIDEO_NOT_DRAFT: vídeo fora de `draft`

---

#### POST /videos/:publicId/upload/complete (SI-03.9)

Fecha o multipart, confere o tamanho e enfileira o processamento. Ordem fixa: `CompleteMultipartUpload` → `HeadObject` (tamanho igual a `size_bytes`) → enqueue idempotente com `jobId = id` → transição condicional `draft → processing` (`phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-10`). Se o `CompleteMultipartUpload` responder `NoSuchUpload` e o `HeadObject` achar o objeto com o tamanho certo, a chamada é tratada como retry de um complete anterior e segue para o enqueue.

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- parts: array, required — ≥ 1 item, cada item `{ part_number: integer ≥ 1, etag: string não vazia }`

**Response 202:**
- public_id: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: quando o body falha na validação do DTO
- 400 INVALID_UPLOAD_PARTS: quando o storage rejeita a lista de partes (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, ou `NoSuchUpload` sem objeto final); o vídeo continua em `draft`
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de vídeo de outro canal
- 409 VIDEO_NOT_DRAFT: vídeo fora de `draft`
- 422 UPLOAD_SIZE_MISMATCH: quando o tamanho do objeto no `HeadObject` difere de `size_bytes`; o vídeo vai para `failed` com `failure_reason = UPLOAD_SIZE_MISMATCH` e o objeto é mantido

---

#### GET /videos/:publicId (SI-03.14)

Leitura do estado do vídeo pelo dono, usada para acompanhar o processamento (`phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- public_id: string
- status: `"draft" | "processing" | "ready" | "failed"`
- failure_reason: string | null
- original_filename: string
- content_type: string
- size_bytes: integer
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- thumbnail_url: string | null — URL pública `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{thumbnail_key}`
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de vídeo de outro canal

---

#### GET /videos/:publicId/stream (SI-03.15)

Redireciona para uma URL pré-assinada de `GetObject` no bucket de vídeos, assinada com `S3_PUBLIC_ENDPOINT`, válida por 3600s, com `ResponseContentType = content_type`. O storage responde `206 Partial Content` aos pedidos com `Range`, então a API e o BFF ficam fora do caminho dos bytes (`phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 302:** corpo vazio, header `Location` com a URL pré-assinada.

**Error responses:**
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de vídeo de outro canal
- 409 VIDEO_NOT_READY: vídeo com `status` diferente de `ready`

---

#### GET /videos/:publicId/download (SI-03.16)

Igual ao stream, com `ResponseContentDisposition = attachment; filename="{original_filename}"` (com `filename*=UTF-8''...` quando o nome não for ASCII) na URL pré-assinada (`phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 302:** corpo vazio, header `Location` com a URL pré-assinada.

**Error responses:**
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de vídeo de outro canal
- 409 VIDEO_NOT_READY: vídeo com `status` diferente de `ready`

---

#### Validation Rules — Upload de vídeos

| Field | Rule | Where | Error |
|-------|------|-------|-------|
| filename | string, 1..255 caracteres | DTO | 400 VALIDATION_ERROR |
| size | inteiro ≥ 1 | DTO | 400 VALIDATION_ERROR |
| size | ≤ `10737418240` | serviço | 413 VIDEO_TOO_LARGE |
| content_type | string não vazia | DTO | 400 VALIDATION_ERROR |
| content_type | `video/mp4` ou `video/webm` | serviço | 415 UNSUPPORTED_VIDEO_FORMAT |
| part_numbers | array de 1..10000 inteiros ≥ 1, únicos | DTO | 400 VALIDATION_ERROR |
| part_numbers[i] | ≤ `part_count` do vídeo | serviço | 400 INVALID_PART_NUMBER |
| parts | array ≥ 1 de `{ part_number: inteiro ≥ 1, etag: string não vazia }` (validação aninhada) | DTO | 400 VALIDATION_ERROR |
| :publicId | string de 11 caracteres `[A-Za-z0-9_-]`; formato diferente responde como inexistente | serviço | 404 VIDEO_NOT_FOUND |

As regras de tamanho e formato ficam no serviço, e não no DTO, para que o frontend receba um código de domínio próprio em vez do `VALIDATION_ERROR` genérico.

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (outro canal) | Owner (canal do vídeo) | Notes |
|----------|-----------|-----------------------------|------------------------|-------|
| POST /videos | ✗ 401 | — | ✓ | O rascunho é criado sempre no canal do usuário autenticado (1:1, criado no cadastro da fase 02) |
| POST /videos/:publicId/upload/part-urls | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | Só com `status = draft` |
| POST /videos/:publicId/upload/complete | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | Só com `status = draft` |
| GET /videos/:publicId | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | Qualquer status |
| GET /videos/:publicId/stream | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | Só com `status = ready`; fases 04/05 ampliam com visibilidade (`phase-03-videos/TD-07`) |
| GET /videos/:publicId/download | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | Só com `status = ready` |

**Owner check:** resolve o canal do usuário autenticado (`ChannelsService.findByUserId(sub)`) e compara com `video.channel_id` (`phase-03-videos/TD-09`, revisão de 2026-11-17). Vídeo de outro canal responde igual a vídeo inexistente (`404 VIDEO_NOT_FOUND`), para não revelar que um `public_id` existe.
**Storage:** o bucket de vídeos é privado e só é lido por URL pré-assinada emitida pela API depois do owner check; o bucket de thumbnails é de leitura pública anônima (`phase-03-videos/TD-03`).

### Error Catalog

**Error response format:** herdado da fase 02 (`phase-02-auth/TD-07`), sem mudança:
```
{ statusCode: number, error: string, message: string }
```
As exceções novas estendem `DomainException` em `src/common/exceptions/domain.exception.ts` e passam pelo `DomainExceptionFilter` global já existente.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_TOO_LARGE | 413 | Video exceeds the maximum size of 10 GiB | POST /videos com `size` > `10737418240` |
| UNSUPPORTED_VIDEO_FORMAT | 415 | Only video/mp4 and video/webm uploads are accepted | POST /videos com `content_type` fora da allowlist (`phase-03-videos/TD-08`) |
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | POST /videos quando o `sub` do token não tem canal |
| VIDEO_NOT_FOUND | 404 | Video not found | Qualquer rota `/videos/:publicId` com `publicId` inexistente, malformado ou de outro canal |
| VIDEO_NOT_DRAFT | 409 | Video upload is no longer in progress | part-urls ou complete com vídeo fora de `draft` |
| INVALID_PART_NUMBER | 400 | Part number is outside the upload range | part-urls com algum número de parte > `part_count` |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts do not match the multipart upload | complete rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload` sem objeto final) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded object size does not match the declared size | complete com `HeadObject.ContentLength` ≠ `size_bytes` (`phase-03-videos/TD-10`) |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | stream ou download com `status` ≠ `ready` (`phase-03-videos/TD-07`) |

#### Failure reasons (`videos.failure_reason`)

Não são respostas HTTP: ficam gravados na linha do vídeo quando ele vai para `failed` e aparecem em `GET /videos/:publicId`. A política comum é: erro permanente falha na hora (BullMQ `UnrecoverableError`, sem retry), erro transitório tenta de novo com backoff e só falha depois da última tentativa, e o objeto original é sempre mantido (`phase-03-videos/TD-09`).

| Reason | Origem | Tipo | Trigger |
|--------|--------|------|---------|
| UPLOAD_SIZE_MISMATCH | API (complete) | permanente | Tamanho do objeto difere do declarado |
| UPLOAD_EXPIRED | worker (`expire-drafts`) | permanente | Vídeo em `draft` com `created_at` há mais de 1 dia (`phase-03-videos/TD-09`, revisão de 2026-11-17) |
| INVALID_MEDIA | worker (`process-video`) | permanente | ffprobe não consegue ler o arquivo, ou não há stream de vídeo, ou a duração não é positiva |
| UNSUPPORTED_CONTAINER | worker (`process-video`) | permanente | `format_name` do ffprobe não bate com o `content_type` declarado (`mp4` para `video/mp4`, `webm` para `video/webm`) (`phase-03-videos/TD-08`) |
| UNSUPPORTED_CODEC | worker (`process-video`) | permanente | Codec fora da allowlist: MP4 aceita vídeo `h264` e áudio `aac` ou `mp3`; WebM aceita vídeo `vp8`, `vp9` ou `av1` e áudio `opus` ou `vorbis`; áudio ausente é aceito nos dois (`phase-03-videos/TD-08`) |
| PROCESSING_FAILED | worker (`process-video`) | transitório esgotado | Erro de I/O, storage ou banco que persistiu nas 3 tentativas |

### Events/Messages

Uma fila BullMQ, `video-processing`, no Redis do Compose (`redis:6379`), com o prefixo de chaves vindo de `QUEUE_PREFIX` (`streamtube` em runtime, `streamtube-test` nos testes). O serviço `video-worker` só escuta o prefixo de runtime, então nunca consome jobs de teste; nos testes de integração e e2e o próprio teste sobe o processor com o prefixo de teste (`phase-03-videos/TD-01`, `phase-03-videos/TD-10`). Os dois jobs abaixo são `Backend`: nenhum é visto pelo frontend, que acompanha o resultado por `GET /videos/:publicId`.

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (enqueue idempotente), `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`.
**Producer:** `VideoProcessingProducer.enqueueProcessing(videoId)`, chamado por `VideosService.completeUpload` antes da transição `draft → processing` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (`@Processor('video-processing')`) no `video-worker`, que delega a `VideoProcessingService.process(videoId)` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
**Trigger:** complete do upload aceito (objeto final no storage com o tamanho declarado).
**Effect:** presigned GET interno (`S3_ENDPOINT`) → `ffprobe` (metadados + checagem de container e codec) → `ffmpeg` extrai um frame em 10% da duração, limitado a 5s → `PutObject` do JPEG em `{id}.jpg` no bucket de thumbnails → vídeo vai para `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` e `thumbnail_key`. Falha permanente vai para `failed` na hora; falha transitória só vai para `failed` (`PROCESSING_FAILED`) no evento `failed` da última tentativa.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). Idempotência por `jobId` na fila e por guarda de status no banco: o processor ignora vídeo já em `ready` ou `failed`, e as transições são `UPDATE ... WHERE status IN (...)`, então um job duplicado ou atrasado não regride o estado.

#### expire-drafts

**Payload:**

```json
{}
```

**Producer:** Job Scheduler `expire-draft-uploads` (`queue.upsertJobScheduler`, `{ every: 3600000 }`), registrado por `DraftExpiryScheduler` no bootstrap do `video-worker`; o upsert é idempotente por id do scheduler (per `phase-03-videos/TD-09`, revisão de 2026-11-17)
**Consumer:** `VideoProcessor`, que delega a `DraftExpiryService.expireDrafts(now)` (per `phase-03-videos/TD-09`)
**Trigger:** a cada 1h (a cadência é parâmetro de implementação).
**Effect:** para cada vídeo em `draft` com `created_at` < `now - 24h`: tenta `AbortMultipartUpload` com o `upload_id` gravado (resposta `NoSuchUpload` significa que a regra de lifecycle já abortou e não é erro) e marca `failed` com `failure_reason = UPLOAD_EXPIRED`.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). Idempotente: a transição é `UPDATE ... WHERE status = 'draft'`, então duas execuções seguidas não mudam nada na segunda.

---

## Dependency Map

```
SI-03.1 (root: infra)
├── SI-03.2 — depends on SI-03.1 (env aponta para os serviços novos)
│   ├── SI-03.4 — depends on SI-03.1 + SI-03.2 (MinIO e storageConfig)
│   └── SI-03.5 — depends on SI-03.1 + SI-03.2 (Redis e queueConfig)
└── SI-03.10 — depends on SI-03.1 + SI-03.4 (ffmpeg na imagem e URL pré-assinada interna)

SI-03.3 (root: entidade e migration)
└── SI-03.6 — depends on SI-03.3 (transições sobre a entidade Video)

SI-03.4 + SI-03.6
└── SI-03.7 — POST /videos
    └── SI-03.8 — POST part-urls (rascunho e owner check)
        ├── SI-03.9 — POST complete, também depends on SI-03.5 (producer)
        ├── SI-03.15 — GET stream (owner check)
        │   └── SI-03.16 — GET download (VideoNotReadyException e assinatura de leitura)
        └── SI-03.14 — GET estado, também depends on SI-03.11 (fluxo completo no spec)

SI-03.5 + SI-03.6 + SI-03.10
└── SI-03.11 — processamento process-video
    └── SI-03.12 — expiração expire-drafts
        └── SI-03.13 — entrypoint do worker e video-worker no compose padrão

SI-03.13 + SI-03.14 + SI-03.16
└── SI-03.17 — openapi.json, api.http e CLAUDE.md
```

Ordem linear de implementação: SI-03.1 → SI-03.2, SI-03.3 (paralelos) → SI-03.4, SI-03.5, SI-03.6 (paralelos) → SI-03.7 → SI-03.8 → SI-03.9, SI-03.10, SI-03.15 (paralelos) → SI-03.11, SI-03.16 → SI-03.12, SI-03.14 → SI-03.13 → SI-03.17

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, Redis, MinIO e ffmpeg no ambiente
- [ ] SI-03.2 — Configuração de storage e fila, com ambiente isolado para testes
- [ ] SI-03.3 — Entidade Video, migration da tabela videos e geração do public_id
- [ ] SI-03.4 — StorageModule com cliente interno e assinador público
- [ ] SI-03.5 — Fila video-processing e producer idempotente
- [ ] SI-03.6 — Transições de status do vídeo e lookup do canal do usuário
- [ ] SI-03.7 — Endpoint POST /videos (início do upload e rascunho)
- [ ] SI-03.8 — Endpoint POST /videos/:publicId/upload/part-urls (URLs de envio das partes)
- [ ] SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (fechamento e enfileiramento)
- [ ] SI-03.10 — MediaInspector (ffprobe/ffmpeg) e política de formatos
- [ ] SI-03.11 — Processamento do vídeo no worker (job process-video)
- [ ] SI-03.12 — Expiração de rascunhos abandonados (job expire-drafts)
- [ ] SI-03.13 — Entrypoint do worker e serviço video-worker no Compose
- [ ] SI-03.14 — Endpoint GET /videos/:publicId (estado do vídeo)
- [ ] SI-03.15 — Endpoint GET /videos/:publicId/stream (reprodução por streaming)
- [ ] SI-03.16 — Endpoint GET /videos/:publicId/download (download do vídeo)
- [ ] SI-03.17 — OpenAPI exportado, api.http e CLAUDE.md com a seção de vídeos

**Ambiente:**

- [ ] `docker compose up -d` sobe `db`, `mailpit`, `redis`, `minio`, `minio-init`, `nestjs-api` e `video-worker`, com o `video-worker` consumindo a fila `video-processing` (o servidor HTTP da API continua só sob pedido)

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, incluindo `dist/worker.js` (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
