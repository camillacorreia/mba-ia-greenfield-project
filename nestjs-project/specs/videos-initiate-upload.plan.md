---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: valida tamanho (até 10 GiB) e formato (`video/mp4` ou `video/webm`), resolve o canal do usuário autenticado, abre o multipart upload no MinIO e grava o vídeo como rascunho (`draft`) com um `public_id` de 11 caracteres. A resposta traz o plano de partes (`part_size` fixo de 100 MiB e `part_count`) para o cliente enviar os bytes direto ao storage.

## Test Scenarios

### 1. Iniciar upload e criar rascunho

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`.

#### 1.1. cria-rascunho-com-plano-de-partes

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer do usuário A e body `{ filename: "aula.mp4", size: 5000000, content_type: "video/mp4" }`
    - expect: status `201`
    - expect: body com `public_id` de 11 caracteres `[A-Za-z0-9_-]`, `status: "draft"`, `part_size: 104857600` e `part_count: 1`
    - expect: body sem `id`, `channel_id` nem `upload_id`
  2. Consultar a linha em `videos` pelo `public_id` devolvido
    - expect: `status = draft`, `channel_id` igual ao canal do usuário A, `original_filename = "aula.mp4"`, `size_bytes = 5000000`
    - expect: `upload_id` não nulo e listado pelo storage como multipart em andamento na chave `{id}` do bucket `videos-test`

#### 1.2. tamanho-maximo-de-10-gib

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer e body `{ filename: "longo.mp4", size: 10737418240, content_type: "video/mp4" }`
    - expect: status `201`
    - expect: `part_count: 103`

### 2. Rejeições de domínio, validação e autenticação

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); env de teste via `src/test/setup-test-env.ts` (`QUEUE_PREFIX=streamtube-test`, buckets `videos-test`/`thumbnails-test`). `beforeEach`: `cleanAllTables` no Postgres de teste e remoção dos jobs da fila `video-processing` com prefixo de teste. Usuários autenticados criados pelo fluxo da fase 02 (register → confirmação → login), o que já cria o canal 1:1 de cada um. `afterAll`: `app.close()`.

#### 2.1. acima-de-10-gib-retorna-413

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer e body `{ filename: "grande.mp4", size: 10737418241, content_type: "video/mp4" }`
    - expect: status `413` com `error: "VIDEO_TOO_LARGE"`
    - expect: a tabela `videos` continua vazia

#### 2.2. formato-fora-da-allowlist-retorna-415

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer e body `{ filename: "aula.mov", size: 5000000, content_type: "video/quicktime" }`
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha criada em `videos`

#### 2.3. body-invalido-retorna-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos com Bearer e body `{ size: 5000000, content_type: "video/mp4" }` (sem `filename`)
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 2.4. sem-token-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-17T16:41:53Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`
