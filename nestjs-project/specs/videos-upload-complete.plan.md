---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` fecha o multipart upload com a lista de `ETag`, confere o tamanho real do objeto contra o `size_bytes` declarado e dispara o processamento assíncrono. A ordem é fixa: `CompleteMultipartUpload` → `HeadObject` → enqueue idempotente de `process-video` com `jobId = id` → transição condicional `draft → processing`. Divergência de tamanho leva o vídeo a `failed` com `UPLOAD_SIZE_MISMATCH`, mantendo o objeto no bucket.

## Test Scenarios

### 1. Fechar o upload e enfileirar o processamento

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Cada cenário cria o rascunho com `POST /videos` usando o tamanho real da fixture MP4 h264/aac da SI-03.10, pede `part_numbers: [1]` e faz o PUT da fixture na URL devolvida, guardando o `ETag`. Nenhum processor roda nesta suíte, então o job fica na fila.

#### 1.1. complete-retorna-202-e-enfileira-job

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com Bearer do dono e body `{ parts: [{ part_number: 1, etag: "<ETag do PUT>" }] }`
    - expect: status `202` com body `{ public_id: "<publicId>", status: "processing" }`
    - expect: a linha em `videos` fica com `status = processing` e `upload_id` nulo
    - expect: o objeto `{id}` existe no bucket `videos-test`
  2. Consultar a fila `video-processing` com prefixo `streamtube-test`
    - expect: existe um job `process-video` com `jobId` igual ao `id` interno do vídeo

#### 1.2. complete-repetido-retorna-409-sem-duplicar-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com o mesmo body válido
    - expect: status `202`
  2. Repetir o mesmo POST
    - expect: status `409` com `error: "VIDEO_NOT_DRAFT"`
    - expect: a fila continua com um único job para o `id` do vídeo

### 2. Rejeições

**Setup:** Mesmo setup do grupo 1.

#### 2.1. etag-errado-retorna-400-e-mantem-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com Bearer do dono e body `{ parts: [{ part_number: 1, etag: "\"00000000000000000000000000000000\"" }] }`
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
    - expect: a linha continua em `status = draft` com `upload_id` preenchido
    - expect: nenhum job `process-video` para o vídeo

#### 2.2. tamanho-divergente-retorna-422-e-marca-failed

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. Criar o rascunho declarando `size` igual ao tamanho da fixture + 1000 bytes (ainda `part_count = 1`), pedir a URL da parte 1 e fazer o PUT só da fixture
  2. POST /videos/:publicId/upload/complete com o `ETag` recebido
    - expect: status `422` com `error: "UPLOAD_SIZE_MISMATCH"`
    - expect: a linha fica com `status = failed` e `failure_reason = UPLOAD_SIZE_MISMATCH`
    - expect: o objeto `{id}` continua no bucket `videos-test`
    - expect: nenhum job `process-video` para o vídeo

#### 2.3. outro-canal-retorna-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com Bearer do usuário B (outro canal) e o body válido do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: a linha do dono continua em `draft`
