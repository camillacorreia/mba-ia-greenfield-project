# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 13/17 completed

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
- **Status:** completed
- **Tests:** 22 passing (13 em `videos.service.spec.ts`, 3 em `videos.service.integration-spec.ts`, 6 em `test/videos-initiate-upload.e2e-spec.ts`); suíte completa verde (unit 231/231, e2e 58/58, tsc e lint com exit 0)
- **Observations:**
  - **Follow-up fora de escopo:** o detector de violação de unicidade do Postgres era privado do `channels.service.ts`. Pra seguir "o mesmo padrão" no retry de `public_id`, criei `src/common/database/pg-errors.ts` com `isPgUniqueViolationOnColumn` e usei só no `VideosService`. O `ChannelsService` ainda tem a cópia local; trocar pelo helper comum fica como tarefa separada.
  - Criei `test/helpers/videos-e2e.ts` (`VideosE2eContext`): AppModule com a config global do `main.ts`, usuários por register → confirmação → login, e `reset()` que aborta os multiparts dos rascunhos, limpa as tabelas, faz `obliterate` da fila `video-processing` no prefixo de teste e zera o throttler. A ideia é reaproveitar nos outros 5 specs e2e de vídeo. O `test/auth.e2e-spec.ts` não foi alterado.
  - A fila ainda não está registrada no `AppModule` (entra com o `complete` no SI-03.9), então o helper abre um `Queue` próprio com `bullRootOptions(queueConfig())` pra limpar os jobs de teste, como o spec pede.
  - Constantes do upload em `src/videos/videos.constants.ts`: `MAX_VIDEO_SIZE_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `ALLOWED_VIDEO_CONTENT_TYPES` e `PUBLIC_ID_MAX_RETRIES`.
  - Se o abort de compensação também falhar, o erro do abort é logado e o erro original do insert é o que sobe (coberto no unit).
  - O e2e confere que a resposta não traz `id`, `channel_id` nem `upload_id`. O integration confere com `ListParts` que o multipart existe no MinIO, e que ele é abortado quando o insert falha.
  - O lint acusou acessos `any` nos mocks do unit e do integration; corrigido tipando `jest.fn<Promise<unknown>, [Video]>()` e o `uploadId` do spy.

### SI-03.8 — Endpoint POST /videos/:publicId/upload/part-urls (URLs de envio das partes)
- **Status:** completed
- **Tests:** 17 novos passing (11 no unit `videos.service.spec.ts`, 1 no `videos.service.integration-spec.ts`, 5 em `test/videos-upload-part-urls.e2e-spec.ts`); suíte completa verde (unit 242/242, e2e 63/63 em duas rodadas seguidas, tsc e lint com exit 0)
- **Observations:**
  - **`--runInBand` no `test:e2e`:** na suíte completa, 6 testes e2e falharam (5 do `videos-initiate-upload` e 1 do `auth`), com login devolvendo 500 por `refresh_tokens violates foreign key constraint`. O log mostrava dois PIDs: o script era `jest --config ./test/jest-e2e.json`, sem `--runInBand`, então os arquivos rodavam em paralelo e um `cleanAllTables` apagava o usuário de outro arquivo no meio do login. O `nestjs-project/CLAUDE.md` já dizia que o e2e roda sempre com `--runInBand` e que o script "already configured", mas não estava. Até o SI-03.7 só o `auth.e2e-spec.ts` mexia no banco, por isso não aparecia. Corrigido no `package.json` (1 tentativa de fix).
  - `findOwnedVideo` faz o owner check com `isValidPublicId` antes de consultar o banco. Vídeo inexistente, de outro canal ou usuário sem canal respondem o mesmo `VIDEO_NOT_FOUND`; o e2e confere que o corpo do 404 de outro canal é igual ao de `abc`.
  - `requestPartUrls` também trata como `VIDEO_NOT_DRAFT` um rascunho sem `upload_id`, por defesa; pela regra do `markProcessing`, isso só acontece fora de `draft`.
  - As URLs são assinadas em paralelo (`Promise.all`) e devolvidas na ordem pedida (coberto no unit com `[3, 1, 2]`).
  - `PART_URL_EXPIRES_IN_SECONDS = 3600` entrou em `videos.constants.ts`, e o cálculo de `part_count` virou a função `partCountFor`, usada por `initiateUpload` e `requestPartUrls`.

### SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (fechamento e enfileiramento)
- **Status:** completed
- **Tests:** 16 novos passing (10 no unit `videos.service.spec.ts`, 1 no `videos.service.integration-spec.ts`, 5 em `test/videos-upload-complete.e2e-spec.ts`); suíte completa verde (unit 252/252, e2e 68/68, tsc e lint com exit 0)
- **Observations:**
  - **Fixture fora de ordem no plano:** o spec e2e e a linha de integration do SI pedem "upload real da fixture" MP4 h264/aac, mas quem cria `test/fixtures/media/` é o SI-03.10, que não é dependência do SI-03.9 e vem depois no mapa. Pra não puxar parte do SI-03.10 pra cá, os testes usam 64 KiB de bytes aleatórios. Nenhum processor roda nessas suítes, então o conteúdo não muda nenhum AC: só o tamanho e os ETags importam. Pendente de decisão: trocar pela fixture depois do SI-03.10.
  - O caminho `NoSuchUpload` no complete trata como retry de um complete anterior e segue para o `HeadObject`; sem objeto final, vira `INVALID_UPLOAD_PARTS`. Erros inesperados do storage sobem sem tradução (coberto no unit).
  - No 422 o vídeo vai para `failed` mantendo o `upload_id` antigo, que já não vale no storage depois do complete. Isso não afeta a expiração (`expire-drafts` só olha `draft`), e o `abortVideoUpload` devolve `false` nesse caso.
  - O `VideosModule` importa o `VideoProcessingQueueModule`, então a API agora abre conexão com o Redis no boot. O integration do `VideosService` passou a registrar `BullModule.forRootAsync` e a limpar a fila de teste.
  - Helper e2e: `VideosE2eContext.queue` passou a ser público (asserts de job); `reset()`/`close()` agora também apagam o objeto final `{id}` e a thumbnail `{id}.jpg` de cada vídeo nos buckets de teste; e entrou `createDraftWithUploadedPart(user, bytes, { declaredSize?, contentType? })`, que cria o rascunho, pede a URL da parte 1 e faz o PUT. O `tsc` exigiu `Uint8Array<ArrayBuffer>` no parâmetro, por causa do `BodyInit` do `fetch`.

### SI-03.10 — MediaInspector (ffprobe/ffmpeg) e política de formatos
- **Status:** completed
- **Tests:** 31 passing (18 em `codec-policy.spec.ts`, 5 em `media-inspector.service.spec.ts`, 8 em `media-inspector.service.integration-spec.ts`); suíte completa verde (unit 283/283, e2e 68/68, tsc e lint com exit 0)
- **Observations:**
  - Fixtures geradas com o ffmpeg 5.1.9 do container a partir de `testsrc`/`sine`: `sample-h264-aac.mp4` (13 KB), `sample-vp9-opus.webm` (14 KB), `sample-mpeg4.mp4` (22 KB, sem áudio) e `not-a-video.mp4` (40 bytes de texto), todas com 1,5s e 320x240. Os comandos estão em `test/fixtures/media/README.md`.
  - **Falha 1/3 corrigida:** o `probe` do `not-a-video.mp4` lançava `Error` em vez de `MediaUnreadableError`. O ffprobe sai com `code: 1, killed: false`, mas a checagem usava `instanceof Error`, e sob o Jest o erro do `child_process` vem de outro realm. Troquei por checagem estrutural de `code`/`killed`.
  - Só saída diferente de zero do ffprobe vira `MediaUnreadableError` (permanente). Timeout ou kill sobem como erro comum, pra cair no retry do worker. JSON inválido do ffprobe também vira `MediaUnreadableError`.
  - O `extractFrame` não traduz erro: falha do ffmpeg sobe como erro comum (transitório), porque um erro de leitura HTTP do storage também sai com código diferente de zero. Saída vazia também vira erro.
  - Dimensão da thumbnail (a critério da implementação): largura máxima de 1280px mantendo a proporção (`scale='min(1280,iw)':-2`).
  - `parseProbeOutput` é exportado para o unit; ignora stream de vídeo com `disposition.attached_pic` (capa embutida) e usa a duração do stream de vídeo quando o format não tem.
  - Content type fora da allowlist na política devolve `UNSUPPORTED_CONTAINER` (na prática o `POST /videos` já barra com 415).
  - O integration também passa o probe real das fixtures pela `checkPlayability`, que é como os ACs da política estão escritos.
  - Pendente do SI-03.9: os testes do complete usam bytes aleatórios; agora que a fixture existe, dá pra trocar se a Camilla quiser.

### SI-03.11 — Processamento do vídeo no worker (job process-video)
- **Status:** completed
- **Tests:** 28 passing (14 em `video-processing.service.spec.ts`, 7 em `video.processor.spec.ts`, 7 em `video-processing.integration-spec.ts`); suíte completa verde (unit 316/316, e2e 73/73, tsc e lint com exit 0)
- **Observations:**
  - Conferido no código do BullMQ 6.7.7 instalado (`job.js`, `moveToFailed`): o evento `failed` do worker é emitido a cada tentativa, com `attemptsMade` já incrementado. O `onFailed` só marca `PROCESSING_FAILED` quando `attemptsMade >= opts.attempts` e o erro não tem `name === 'UnrecoverableError'`, que é a mesma checagem que o BullMQ usa em `shouldRetryJob`.
  - Se a política devolve `ok` mas o probe vem sem vídeo ou sem duração (não deveria acontecer), o service trata como `INVALID_MEDIA` em vez de seguir com dados incompletos.
  - Só a falha do `probe` com `MediaUnreadableError` vira permanente. Falha do `extractFrame`, do `putThumbnail` ou do banco sobe como transitória (unit cobre os três).
  - O `onFailed` ignora jobs que não sejam `process-video`, pra não marcar vídeo por causa do `expire-drafts` (SI-03.12).
  - `startTestProcessor()` usa `synchronize: false` no TypeORM: o banco de teste já está migrado, e o processor não deve alterar schema.
  - Integration: o erro transitório é simulado com `jest.spyOn(inspector, 'probe')` no `MediaInspector` do próprio processor. As 3 tentativas levam ~3s por causa do backoff exponencial de 1s. O job duplicado usa outro `jobId`, porque o `jobId = videoId` original já existe na fila e seria ignorado pelo BullMQ.
  - O `AppModule` não importa o `VideoProcessingModule` (conferido por grep); só o `start-test-processor.ts` importa por enquanto, e o entrypoint do worker vem no SI-03.13.

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
- **Status:** completed
- **Tests:** 10 novos passing (5 no unit `videos.service.spec.ts`, 5 em `test/videos-stream.e2e-spec.ts`); suíte completa verde (unit 288/288, e2e 73/73, tsc e lint com exit 0)
- **Observations:**
  - **Desvio da ação técnica 3, `@Res()` no lugar de `@Redirect()`:** o `@Redirect()` do Nest chama o `res.redirect()` do Express, que escreve `Found. Redirecting to <url>` no corpo. O AC #1 e o contrato (`Response 302: corpo vazio`) pedem corpo vazio, e o e2e falhou nisso (1 tentativa de fix). O handler agora usa `@Res()` com `res.status(302).location(url).end()`. As exceções lançadas antes de escrever a resposta continuam passando pelos filtros globais (409/404/401 cobertos no e2e). A documentação OpenAPI do 302 com header `Location` se mantém.
  - `READ_URL_EXPIRES_IN_SECONDS = 3600` entrou em `videos.constants.ts`, e o owner check + exigência de `ready` ficou num `findReadyOwnedVideo` privado, que o download (SI-03.16) vai reaproveitar.
  - O unit também confere que o owner check vem antes do status: vídeo de outro canal em `processing` dá `VIDEO_NOT_FOUND`, não `VIDEO_NOT_READY`.
  - Helper e2e: entrou `seedVideo(user, status, overrides)`, que grava a linha direto no canal do usuário e, em `ready`, sobe a fixture `sample-h264-aac.mp4` na chave `{id}` do bucket de teste; e o export `SAMPLE_MP4`.
  - A URL pré-assinada de leitura traz `x-amz-checksum-mode=ENABLED`, que o SDK acrescenta por padrão (`responseChecksumValidation`); o MinIO aceita normalmente.

### SI-03.16 — Endpoint GET /videos/:publicId/download (download do vídeo)
- **Status:** completed
- **Tests:** 14 novos passing (5 em `content-disposition.util.spec.ts`, 4 no unit `videos.service.spec.ts`, 5 em `test/videos-download.e2e-spec.ts`); suíte completa verde (unit 325/325, e2e 78/78, tsc e lint com exit 0)
- **Observations:**
  - **Mesmo desvio do SI-03.15, `@Res()` no lugar de `@Redirect()`:** o contrato do download também pede `Response 302: corpo vazio`, e o `@Redirect()` escreveria `Found. Redirecting to ...`. Apliquei a mesma solução direto, por consistência com a decisão já registrada no SI-03.15.
  - `attachmentDisposition`: o fallback ASCII troca cada caractere fora de ASCII por `_` (`vídeo final.mp4` → `filename="v_deo final.mp4"`), e o `filename*` escapa também `'()*!`, que o `encodeURIComponent` deixa passar mas a RFC 8187 exige. Se não sobrar nada do nome depois da limpeza, usa `video`.
  - A remoção de CR/LF impede injeção de header pelo `original_filename` (coberto no unit com `\r\nSet-Cookie`).
  - O e2e confere os headers servidos pelo MinIO de verdade, seguindo o `Location`: `Content-Disposition` exato para `aula.mp4`, `filename*` para o nome com acento e `Content-Length` igual a `size_bytes`.

### SI-03.17 — OpenAPI exportado, api.http e CLAUDE.md com a seção de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
