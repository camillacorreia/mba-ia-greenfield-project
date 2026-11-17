---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:publicId/upload/part-urls Test Plan

## Application Overview

`POST /videos/:publicId/upload/part-urls` devolve ao dono de um rascunho as URLs pré-assinadas de `UploadPart` (assinadas com `S3_PUBLIC_ENDPOINT`, válidas por 3600s), na ordem pedida, para o cliente enviar cada parte direto ao storage. A rota pode ser chamada de novo enquanto o vídeo estiver em `draft`. É aqui que entra o owner check: vídeo de outro canal responde igual a vídeo inexistente (`404 VIDEO_NOT_FOUND`).

## Test Scenarios

### 1. Emitir URLs de envio das partes

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Cada cenário cria o rascunho com `POST /videos` (`size: 5000000`, `content_type: "video/mp4"`, logo `part_count = 1`).

#### 1.1. emite-url-assinada-que-aceita-a-parte

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com Bearer do dono e body `{ part_numbers: [1] }`
    - expect: status `200`
    - expect: `parts[0].part_number = 1`, `parts[0].url` com host igual ao de `S3_PUBLIC_ENDPOINT` e `expires_in: 3600`
  2. PUT de bytes na `parts[0].url` (fora da API, cliente HTTP direto ao storage)
    - expect: o storage responde `200` com header `ETag` não vazio

### 2. Rejeições

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`. Cada cenário cria o rascunho com `POST /videos` (`size: 5000000`, `content_type: "video/mp4"`).

#### 2.1. parte-acima-do-part-count-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com Bearer do dono e body `{ part_numbers: [2] }`
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`

#### 2.2. outro-canal-e-public-id-inexistente-retornam-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com Bearer do usuário B (outro canal) e body `{ part_numbers: [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. POST /videos/abc/upload/part-urls com Bearer do dono e body `{ part_numbers: [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`, mesmo envelope do passo 1

#### 2.3. video-fora-de-draft-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. Atualizar a linha do rascunho direto no banco para `status = processing`
  2. POST /videos/:publicId/upload/part-urls com Bearer do dono e body `{ part_numbers: [1] }`
    - expect: status `409` com `error: "VIDEO_NOT_DRAFT"`

#### 2.4. part-numbers-vazio-ou-repetido-retorna-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com Bearer do dono e body `{ part_numbers: [] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos/:publicId/upload/part-urls com Bearer do dono e body `{ part_numbers: [1, 1] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
