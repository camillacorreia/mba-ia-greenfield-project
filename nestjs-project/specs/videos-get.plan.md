---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId Test Plan

## Application Overview

`GET /videos/:publicId` devolve ao dono o estado e os metadados do vídeo, que é como o cliente acompanha o processamento até `ready` ou `failed`. A resposta expõe só `public_id` (nunca `id`, `channel_id` ou `upload_id`) e monta `thumbnail_url` como URL pública do bucket de thumbnails. Este spec cobre também o fluxo completo upload → complete → processamento → `ready` com o processor de teste.

## Test Scenarios

### 1. Ler o estado do vídeo

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`.

#### 1.1. rascunho-proprio-sem-campos-internos

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer do dono e body `{ filename: "aula.mp4", size: 5000000, content_type: "video/mp4" }`
    - expect: status `201`
  2. GET /videos/:publicId com Bearer do dono
    - expect: status `200` com `status: "draft"`, `duration_seconds: null`, `thumbnail_url: null`, `original_filename: "aula.mp4"`, `size_bytes: 5000000` numérico
    - expect: `created_at` e `updated_at` em ISO-8601
    - expect: corpo sem as chaves `id`, `channel_id` e `upload_id`

#### 1.2. video-falho-expoe-failure-reason

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. Semear direto no banco um vídeo do dono com `status = failed` e `failure_reason = UNSUPPORTED_CODEC`
  2. GET /videos/:publicId com Bearer do dono
    - expect: status `200` com `status: "failed"` e `failure_reason: "UNSUPPORTED_CODEC"`

### 2. Fluxo completo até ready

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Além disso, `beforeAll` sobe o processor de teste com `src/test/start-test-processor.ts` (prefixo `streamtube-test`) e `afterAll` chama a função de encerramento devolvida. Timeout do teste estendido para cobrir o ffmpeg.

#### 2.1. upload-complete-processamento-chega-a-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer do dono, `content_type: "video/mp4"` e `size` igual ao tamanho da fixture MP4 h264/aac da SI-03.10
    - expect: status `201` com `part_count: 1`
  2. POST /videos/:publicId/upload/part-urls com `{ part_numbers: [1] }` e PUT da fixture na URL devolvida
    - expect: o storage responde com `ETag`
  3. POST /videos/:publicId/upload/complete com o `ETag`
    - expect: status `202` com `status: "processing"`
  4. Fazer polling de GET /videos/:publicId com Bearer do dono até `status` sair de `processing`
    - expect: `status: "ready"`, `duration_seconds > 0`, `width` e `height` iguais aos da fixture, `video_codec: "h264"`
    - expect: `thumbnail_url` não nulo, no formato `{S3_PUBLIC_ENDPOINT}/thumbnails-test/{thumbnail_key}`
  5. GET anônimo (sem `Authorization`) direto na `thumbnail_url`
    - expect: o storage responde `200`

### 3. Autorização

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`.

#### 3.1. outro-canal-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. Usuário A cria um rascunho com POST /videos
  2. GET /videos/:publicId com Bearer do usuário B (outro canal)
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 3.2. sem-token-retorna-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId de um rascunho existente sem header `Authorization`
    - expect: status `401`
