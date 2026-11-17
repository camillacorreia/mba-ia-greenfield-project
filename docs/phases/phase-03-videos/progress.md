# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/17 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — StorageModule com cliente interno e assinador público
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Fila video-processing e producer idempotente
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Transições de status do vídeo e lookup do canal do usuário
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
