---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/:publicId/download Test Plan

## Application Overview

`GET /videos/:publicId/download` funciona como o stream, mas a URL pré-assinada força `Content-Disposition: attachment` com o nome original do arquivo (com `filename*=UTF-8''...` quando o nome não é ASCII), para o navegador baixar em vez de reproduzir.

## Test Scenarios

### 1. Redirecionar para download

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Vídeo semeado direto no banco (linha em `videos` no canal do dono, com o `status` pedido pelo cenário) e, quando em `ready`, a fixture MP4 h264/aac da SI-03.10 gravada na chave `{id}` do bucket `videos-test`, sem depender do worker.

#### 1.1. ready-serve-attachment-com-nome-original

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/download com Bearer do dono de um vídeo `ready` com `original_filename = "aula.mp4"` (sem seguir redirect)
    - expect: status `302` com header `Location`
  2. GET direto na URL do `Location`
    - expect: o storage responde `200`
    - expect: `Content-Disposition: attachment; filename="aula.mp4"`
    - expect: `Content-Length` igual a `size_bytes`

#### 1.2. nome-nao-ascii-usa-filename-estrela

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/download com Bearer do dono de um vídeo `ready` com `original_filename = "vídeo final.mp4"`
    - expect: status `302`
  2. GET direto na URL do `Location`
    - expect: `Content-Disposition` contém `filename*=UTF-8''v%C3%ADdeo%20final.mp4`

### 2. Rejeições

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Vídeo semeado direto no banco (linha em `videos` no canal do dono, com o `status` pedido pelo cenário) e, quando em `ready`, a fixture MP4 h264/aac da SI-03.10 gravada na chave `{id}` do bucket `videos-test`, sem depender do worker.

#### 2.1. video-em-draft-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/download com Bearer do dono de um vídeo em `draft`
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 2.2. outro-canal-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/download com Bearer do usuário B (outro canal) para o vídeo `ready` do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 2.3. sem-token-retorna-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. GET /videos/:publicId/download sem header `Authorization`
    - expect: status `401`
