# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/17 completed

### SI-03.1 — Infra: dependências, Redis, MinIO e ffmpeg no ambiente
- **Status:** completed
- **Tests:** no tests (Infra). ACs conferidos à mão; suíte existente verde (unit 144/144, e2e 52/52, tsc e lint com exit 0)
- **Observations:**
  - **Desvio 1, `ioredis@^5` no lugar de `^6.0.0`:** `npm install ioredis@^6.0.0` falhou com ERESOLVE porque `typeorm@0.3.28` declara `ioredis@^5.0.4` como peer opcional (`npm view typeorm@0.3.28 peerDependenciesMeta.ioredis` → `optional: true`). O BullMQ 6.7.7 só pede `ioredis >=5.0.0`. Com `^5` (o npm gravou `^5.11.1`), `npm ls ioredis` mostra uma cópia única 5.11.1, deduplicada entre bullmq e typeorm, sem `--legacy-peer-deps`. A linha foi corrigida no `library-refs.md` com nota datada. Decisão da Camilla em 2026-11-17.
  - **Desvio 2, abort de multipart pela config do MinIO no lugar de lifecycle:** `mc ilm import` com `AbortIncompleteMultipartUpload` é rejeitado ("The XML you provided was not well-formed or did not validate against our published schema"), testado com três formatos de JSON (sem `Filter`, com `Filter: {}` e com `Prefix: ""`). O MinIO limpa multipart incompleto pela config de servidor `api stale_uploads_expiry` (padrão 24h, varredura a cada 6h). O `docker/minio-init.sh` agora roda `mc admin config set local api stale_uploads_expiry=24h`, que é idempotente. O AC "`mc ilm export` mostra a regra" virou "`mc admin config get local api` mostra `stale_uploads_expiry=24h`", e foi conferido. A config vale para o servidor inteiro, não por bucket. Decisão da Camilla em 2026-11-17.
  - O healthcheck do MinIO usa `curl -f http://localhost:9000/minio/health/ready` (o curl existe na imagem `pgsty/minio`). A imagem `pgsty/mc` tem entrypoint `mc`, então o `minio-init` sobrescreve com `/bin/sh /minio-init.sh`, montado de `./docker/minio-init.sh`.
  - Evidência dos ACs: `docker compose up -d` deixa redis/minio `healthy`, minio-init `Exited (0)` e nestjs-api `Up`. Segundo `docker compose up minio-init` também sai com 0. `redis-cli ping` responde `PONG`. `ffprobe`/`ffmpeg -version` saem com 0. GET anônimo dá 404 em `thumbnails/inexistente.jpg` e 403 em `videos/inexistente`. Política anônima: `download` em thumbnails, `private` em videos.

### SI-03.2 — Configuração de storage e fila, com ambiente isolado para testes
- **Status:** completed
- **Tests:** 16 passing (`src/config/env.validation.integration-spec.ts`); suíte completa verde (unit 156/156, e2e 52/52, tsc e lint com exit 0)
- **Observations:**
  - O `.env` local (gitignored, fora do diff) também recebeu o bloco S3/Redis do `.env.example`. Sem isso a validação Joi derruba a app e as suítes que sobem o `AppModule`.
  - O spec ganhou um `describe` que confere `process.env` dentro do Jest (`QUEUE_PREFIX=streamtube-test`, buckets `-test` e `S3_PUBLIC_ENDPOINT` igual a `S3_ENDPOINT`), pra cobrir o AC de isolamento. O e2e passa pelo mesmo `setup-test-env.ts` (`<rootDir>/../src/test/setup-test-env.ts`).
  - O `setup-test-env.ts` só iguala `S3_PUBLIC_ENDPOINT` a `S3_ENDPOINT` quando o `S3_ENDPOINT` existe, pra não gravar a string `undefined` se o `.env` faltar.
  - ACs de bootstrap conferidos com `dist/main.js`: sem `S3_BUCKET_VIDEOS`, sai com exit 1 e `"S3_BUCKET_VIDEOS" is required`; com o `.env`, `GET /` responde 200. Pra testar sem a variável, precisei rodar com cwd fora do projeto, porque o `ConfigModule` lê `./.env` sozinho.

### SI-03.3 — Entidade Video, migration da tabela videos e geração do public_id
- **Status:** completed
- **Tests:** 22 passing (`public-id.util.spec.ts`, `video.entity.integration-spec.ts`, `migrations.integration-spec.ts`); suíte completa verde (unit 176/176, e2e 52/52, tsc e lint com exit 0)
- **Observations:**
  - Migration gerada: `1794934411093-CreateVideos.ts`. O diff saiu só com `videos` (enum, tabela, FK `ON DELETE CASCADE`, índices de `channel_id` e `(status, created_at)`, unique de `public_id` como constraint). Ciclo `migration:run`, `migration:revert` e `migration:run` conferido no banco de dev: tabela e `videos_status_enum` somem e voltam.
  - `Video` entrou nos 10 arrays `ALL_ENTITIES` dos specs de auth, users e channels. Sem isso, o `Channel#videos` quebra a metadata do TypeORM nesses specs. O e2e não precisou de ajuste porque usa `autoLoadEntities` via `VideosModule`.
  - O spec da entidade também cobre o transformer de `size_bytes` (10 GiB volta como `number`) e o AC de que apagar usuário com canal continua bloqueado pela FK da fase 02.
  - O spec de migrations ganhou um teste do conteúdo do enum e um teste de revert do `CreateVideos`, que roda antes do revert de `CreateAuthTokens` que já existia.

### SI-03.4 — StorageModule com cliente interno e assinador público
- **Status:** completed
- **Tests:** 14 passing (`storage.service.integration-spec.ts`, `storage.module.spec.ts`); suíte completa verde (unit 190/190, e2e 52/52, tsc e lint com exit 0)
- **Observations:**
  - O MinIO responde 204 ao `AbortMultipartUpload` de um `UploadId` já abortado, e até de um inexistente. Ele nunca devolve `NoSuchUpload` no abort, então o `false` do AC não aparecia (1 tentativa de fix). Conferido com um script direto no SDK: só o `ListParts` acusa `NoSuchUpload` nesse caso. O `abortVideoUpload` agora roda um `ListParts` (`MaxParts: 1`) antes do abort, e continua tratando `NoSuchUpload` no próprio abort, que é como o S3 da AWS responde. Custa uma chamada a mais por abort, e o único consumidor é o `expire-drafts`.
  - Os hosts dos assinadores são conferidos num módulo à parte, com `S3_PUBLIC_ENDPOINT=http://localhost:9000`, porque nos testes os dois endpoints são iguais. Esse bloco só assina URLs e não faz requisição.
  - Testes além da tabela do SI: tradução de erros (`StorageInvalidPartsError` com ETag errado, `StorageNoSuchUploadError` ao concluir upload abortado), `headVideo` devolvendo `null`, overrides de `Content-Type` e `Content-Disposition` no GET assinado, e ausência de checksum na URL de `UploadPart`.
  - Os objetos criados nos buckets `-test` são apagados no `afterAll`. Os multiparts abertos pelos testes são abortados no próprio teste.
  - O `StorageService` destrói os dois `S3Client` no `onModuleDestroy`.

### SI-03.5 — Fila video-processing e producer idempotente
- **Status:** completed
- **Tests:** 6 passing (`video-processing.producer.integration-spec.ts`, `video-processing-queue.module.spec.ts`); suíte completa verde (unit 196/196, e2e 52/52, tsc e lint com exit 0)
- **Observations:**
  - **Desvio, `@nestjs/bullmq@^11.0.5` no lugar de `^12.0.2`:** a 12.x e a dependência `@nestjs/bull-shared@12` são publicadas só como ESM (`"type": "module"`, `exports.require` aponta para o mesmo `.js` ESM). O Node 25 carrega via `require(esm)`, então a app rodava. Mas o Jest (CommonJS) falhava com `SyntaxError: Unexpected token 'export'` em `node_modules/@nestjs/bullmq/dist/index.js`, quebrando os specs do SI e os 3 e2e, que importam o `AppModule`. A 11.0.5 (2026-08-07) é CommonJS e tem peer `bullmq ^3 || ^4 || ^5 || ^6` e Nest `^10 || ^11`. `npm ls` mostra `@nestjs/bullmq@11.0.5` e `@nestjs/bull-shared@11.0.5`, com `bullmq@6.7.7` deduplicado. O `library-refs.md` foi corrigido com nota datada no frontmatter, na tabela de versões e na seção do pacote; ele afirmava que só a 12.x aceitava BullMQ 6. Decisão da Camilla em 2026-11-17.
  - No BullMQ 6 o `Queue` não expõe mais `client`, por causa dos backends plugáveis. O teste de prefixo usa `queue.toKey(videoId)` e um cliente `ioredis` próprio pra conferir que a chave existe sob `streamtube-test` e não sob `streamtube`.
  - O teste limpa a fila com `queue.obliterate({ force: true })`, que só afeta o prefixo de teste.
  - AC de bootstrap: o `dist/main.js` sobe, loga `BullModule dependencies initialized` e `GET /` responde 200. O `AppModule` ainda não importa o `VideoProcessingQueueModule` (isso entra com o `VideosService` nos próximos SIs), então nenhuma conexão com o Redis é aberta no boot por enquanto. A conexão real está coberta pelos testes do SI.

### SI-03.6 — Transições de status do vídeo e lookup do canal do usuário
- **Status:** completed
- **Tests:** 19 novos passing (17 em `video-lifecycle.service.integration-spec.ts`, 2 em `channels.service.integration-spec.ts`); suíte completa verde (unit 215/215, e2e 52/52, tsc e lint com exit 0)
- **Observations:**
  - As transições ficam num único método privado `transition(id, fromStatuses, changes)`, que faz um `UPDATE ... WHERE id = :id AND status IN (...)` via query builder e devolve `affected > 0`. Com a lista de origem vazia, ele devolve `false` sem ir ao banco.
  - O `findByUserId` usa `dataSource.getRepository(Channel)`, que é o estilo do `ChannelsService` existente (ele injeta `DataSource`, não repositório).
  - O `findExpiredDrafts` ordena por `created_at` ascendente, o que não estava no plano. Fica determinístico e processa primeiro os rascunhos mais antigos.
  - `VideoMetadata.audio_codec` é `string | null` (arquivo sem áudio), conforme o Data Model.

### SI-03.7 — Endpoint POST /videos (início do upload e rascunho)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoint POST /videos/:publicId/upload/part-urls (URLs de envio das partes)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (fechamento e enfileiramento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — MediaInspector (ffprobe/ffmpeg) e política de formatos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Processamento do vídeo no worker (job process-video)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Expiração de rascunhos abandonados (job expire-drafts)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Entrypoint do worker e serviço video-worker no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Endpoint GET /videos/:publicId (estado do vídeo)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Endpoint GET /videos/:publicId/stream (reprodução por streaming)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — Endpoint GET /videos/:publicId/download (download do vídeo)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.17 — OpenAPI exportado, api.http e CLAUDE.md com a seção de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
