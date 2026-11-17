import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { StorageService } from '../src/storage/storage.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  type AuthenticatedUser,
  type UploadedDraft,
  VideosE2eContext,
} from './helpers/videos-e2e';

// Bytes arbitrários: nenhum processor roda nesta suíte, então o conteúdo não
// importa para o complete (só o tamanho e os ETags).
const UPLOAD_BYTES = new Uint8Array(randomBytes(64 * 1024));

describe('videos-upload-complete', () => {
  const ctx = new VideosE2eContext();
  let owner: AuthenticatedUser;
  let otherUser: AuthenticatedUser;

  beforeAll(async () => {
    await ctx.init();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = await ctx.registerConfirmAndLogin('owner@example.com');
    otherUser = await ctx.registerConfirmAndLogin('other@example.com');
  });

  function complete(draft: UploadedDraft, token: string, etag = draft.etag) {
    return request(ctx.server())
      .post(`/videos/${draft.publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] });
  }

  async function findVideo(publicId: string): Promise<Video> {
    return ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
  }

  async function jobCountFor(videoId: string): Promise<number> {
    const job = await ctx.queue.getJob(videoId);
    return job ? 1 : 0;
  }

  function errorOf(res: request.Response): string {
    return (res.body as ApiErrorEnvelope).error;
  }

  // 1. Fechar o upload e enfileirar o processamento

  test('complete-retorna-202-e-enfileira-job', async () => {
    const draft = await ctx.createDraftWithUploadedPart(owner, UPLOAD_BYTES);

    const res = await complete(draft, owner.accessToken);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      public_id: draft.publicId,
      status: 'processing',
    });
    const video = await findVideo(draft.publicId);
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    await expect(ctx.app.get(StorageService).headVideo(video.id)).resolves.toBe(
      UPLOAD_BYTES.length,
    );

    const job = await ctx.queue.getJob(video.id);
    expect(job?.name).toBe('process-video');
    expect(job?.id).toBe(video.id);
  });

  test('complete-repetido-retorna-409-sem-duplicar-job', async () => {
    const draft = await ctx.createDraftWithUploadedPart(owner, UPLOAD_BYTES);

    const first = await complete(draft, owner.accessToken);
    const second = await complete(draft, owner.accessToken);

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(errorOf(second)).toBe('VIDEO_NOT_DRAFT');
    const video = await findVideo(draft.publicId);
    const counts = await ctx.queue.getJobCounts('waiting', 'active', 'delayed');
    expect(counts.waiting + counts.active + counts.delayed).toBe(1);
    await expect(jobCountFor(video.id)).resolves.toBe(1);
  });

  // 2. Rejeições

  test('etag-errado-retorna-400-e-mantem-draft', async () => {
    const draft = await ctx.createDraftWithUploadedPart(owner, UPLOAD_BYTES);

    const res = await complete(
      draft,
      owner.accessToken,
      '"00000000000000000000000000000000"',
    );

    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('INVALID_UPLOAD_PARTS');
    const video = await findVideo(draft.publicId);
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).not.toBeNull();
    await expect(jobCountFor(video.id)).resolves.toBe(0);
  });

  test('tamanho-divergente-retorna-422-e-marca-failed', async () => {
    const draft = await ctx.createDraftWithUploadedPart(owner, UPLOAD_BYTES, {
      declaredSize: UPLOAD_BYTES.length + 1000,
    });

    const res = await complete(draft, owner.accessToken);

    expect(res.status).toBe(422);
    expect(errorOf(res)).toBe('UPLOAD_SIZE_MISMATCH');
    const video = await findVideo(draft.publicId);
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.failure_reason).toBe('UPLOAD_SIZE_MISMATCH');
    await expect(ctx.app.get(StorageService).headVideo(video.id)).resolves.toBe(
      UPLOAD_BYTES.length,
    );
    await expect(jobCountFor(video.id)).resolves.toBe(0);
  });

  test('outro-canal-retorna-404', async () => {
    const draft = await ctx.createDraftWithUploadedPart(owner, UPLOAD_BYTES);

    const res = await complete(draft, otherUser.accessToken);

    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    await expect(findVideo(draft.publicId)).resolves.toMatchObject({
      status: VideoStatus.DRAFT,
    });
  });
});
