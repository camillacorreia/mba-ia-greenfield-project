import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import {
  startTestProcessor,
  type TestProcessor,
} from '../src/test/start-test-processor';
import { VideoStatus } from '../src/videos/entities/video.entity';
import {
  type AuthenticatedUser,
  SAMPLE_MP4,
  VideosE2eContext,
} from './helpers/videos-e2e';

interface VideoBody {
  public_id: string;
  title: string;
  status: string;
  failure_reason: string | null;
  original_filename: string;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROCESSING_TIMEOUT_MS = 30_000;

describe('videos-get', () => {
  const ctx = new VideosE2eContext();
  let processor: TestProcessor;
  let owner: AuthenticatedUser;
  let otherUser: AuthenticatedUser;

  beforeAll(async () => {
    await ctx.init();
    // Consumer da fila no prefixo de teste, para o fluxo completo até ready.
    processor = await startTestProcessor();
  });

  afterAll(async () => {
    await processor.close();
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = await ctx.registerConfirmAndLogin('owner@example.com');
    otherUser = await ctx.registerConfirmAndLogin('other@example.com');
  });

  function getVideo(publicId: string, token?: string) {
    const req = request(ctx.server()).get(`/videos/${publicId}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function createDraft(user: AuthenticatedUser): Promise<string> {
    const res = await request(ctx.server())
      .post('/videos')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ filename: 'aula.mp4', size: 5000000, content_type: 'video/mp4' })
      .expect(201);
    return (res.body as { public_id: string }).public_id;
  }

  // 1. Ler o estado do vídeo

  test('rascunho-proprio-sem-campos-internos', async () => {
    const publicId = await createDraft(owner);

    const res = await getVideo(publicId, owner.accessToken);

    expect(res.status).toBe(200);
    const body = res.body as VideoBody;
    expect(body).toMatchObject({
      public_id: publicId,
      title: 'aula',
      status: 'draft',
      duration_seconds: null,
      thumbnail_url: null,
      original_filename: 'aula.mp4',
      size_bytes: 5000000,
    });
    expect(typeof body.size_bytes).toBe('number');
    expect(body.created_at).toMatch(ISO_8601);
    expect(body.updated_at).toMatch(ISO_8601);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('channel_id');
    expect(body).not.toHaveProperty('upload_id');
    expect(body).not.toHaveProperty('storage_key');
  });

  test('titulo-enviado-aparece-no-estado', async () => {
    const created = await request(ctx.server())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Aula 1: introdução',
        filename: 'aula.mp4',
        size: 5000000,
        content_type: 'video/mp4',
      })
      .expect(201);
    const { public_id: publicId } = created.body as { public_id: string };

    const res = await getVideo(publicId, owner.accessToken);

    expect(res.status).toBe(200);
    expect((res.body as VideoBody).title).toBe('Aula 1: introdução');
  });

  test('video-falho-expoe-failure-reason', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.FAILED, {
      failure_reason: 'UNSUPPORTED_CODEC',
    });

    const res = await getVideo(video.public_id, owner.accessToken);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'failed',
      failure_reason: 'UNSUPPORTED_CODEC',
    });
  });

  // 2. Fluxo completo até ready

  test(
    'upload-complete-processamento-chega-a-ready',
    async () => {
      const draft = await ctx.createDraftWithUploadedPart(
        owner,
        new Uint8Array(SAMPLE_MP4),
      );
      expect(draft.etag).toBeTruthy();

      const completed = await request(ctx.server())
        .post(`/videos/${draft.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts: [{ part_number: 1, etag: draft.etag }] });
      expect(completed.status).toBe(202);
      expect(completed.body).toMatchObject({ status: 'processing' });

      let body: VideoBody;
      const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
      for (;;) {
        body = (await getVideo(draft.publicId, owner.accessToken).expect(200))
          .body as VideoBody;
        if (body.status !== 'processing' || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(body).toMatchObject({
        status: 'ready',
        width: 320,
        height: 240,
        video_codec: 'h264',
      });
      expect(body.duration_seconds).toBeGreaterThan(0);
      const publicEndpoint = (process.env.S3_PUBLIC_ENDPOINT ?? '').replace(
        /\/+$/,
        '',
      );
      expect(body.thumbnail_url).toMatch(
        new RegExp(
          `^${publicEndpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/thumbnails-test/[0-9a-f-]{36}\\.jpg$`,
        ),
      );

      const thumbnail = await fetch(body.thumbnail_url ?? '');
      await thumbnail.arrayBuffer();
      expect(thumbnail.status).toBe(200);
    },
    PROCESSING_TIMEOUT_MS + 15_000,
  );

  // 3. Autorização

  test('outro-canal-retorna-404', async () => {
    const publicId = await createDraft(owner);

    const res = await getVideo(publicId, otherUser.accessToken);

    expect(res.status).toBe(404);
    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });

  test('sem-token-retorna-401', async () => {
    const publicId = await createDraft(owner);

    const res = await getVideo(publicId);

    expect(res.status).toBe(401);
  });
});
