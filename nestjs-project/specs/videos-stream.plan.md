---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/:publicId/stream Test Plan

## Application Overview

`GET /videos/:publicId/stream` redireciona (`302`) o dono de um vídeo `ready` para uma URL pré-assinada de `GetObject` no bucket de vídeos, assinada com `S3_PUBLIC_ENDPOINT`, válida por 3600s e com `ResponseContentType` igual ao `content_type` do vídeo. O storage atende `Range` com `206`, então os bytes não passam pela API.

## Test Scenarios

### 1. Redirecionar para streaming

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Vídeo semeado direto no banco (linha em `videos` no canal do dono, com o `status` pedido pelo cenário) e, quando em `ready`, a fixture MP4 h264/aac da SI-03.10 gravada na chave `{id}` do bucket `videos-test`, sem depender do worker.

#### 1.1. ready-redireciona-para-url-assinada

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/stream com Bearer do dono de um vídeo em `ready` (sem seguir redirect)
    - expect: status `302` com corpo vazio
    - expect: header `Location` com host igual ao de `S3_PUBLIC_ENDPOINT` e query `X-Amz-Expires=3600`

#### 1.2. location-atende-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/stream com Bearer do dono e capturar o `Location`
  2. GET direto na URL do `Location` com header `Range: bytes=0-1023`
    - expect: o storage responde `206`
    - expect: `Content-Range: bytes 0-1023/{size_bytes}`
    - expect: `Content-Type` igual ao `content_type` do vídeo (`video/mp4`)

### 2. Rejeições

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Vídeo semeado direto no banco (linha em `videos` no canal do dono, com o `status` pedido pelo cenário) e, quando em `ready`, a fixture MP4 h264/aac da SI-03.10 gravada na chave `{id}` do bucket `videos-test`, sem depender do worker.

#### 2.1. video-em-processing-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/stream com Bearer do dono de um vídeo em `processing`
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 2.2. outro-canal-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/stream com Bearer do usuário B (outro canal) para o vídeo `ready` do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: sem header `Location`

#### 2.3. sem-token-retorna-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/stream sem header `Authorization`
    - expect: status `401`
