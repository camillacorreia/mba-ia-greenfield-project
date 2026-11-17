import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { type AuthenticatedUser, VideosE2eContext } from './helpers/videos-e2e';

describe('videos-download', () => {
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

  function download(video: Video, token?: string) {
    const req = request(ctx.server()).get(
      `/videos/${video.public_id}/download`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.redirects(0);
  }

  async function followLocation(location: string): Promise<Response> {
    const response = await fetch(location);
    await response.arrayBuffer();
    return response;
  }

  // 1. Redirecionar para download

  test('ready-serve-attachment-com-nome-original', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY, {
      original_filename: 'aula.mp4',
    });

    const res = await download(video, owner.accessToken);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBeTruthy();
    const file = await followLocation(res.headers.location);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
    expect(file.headers.get('content-length')).toBe(String(video.size_bytes));
  });

  test('nome-nao-ascii-usa-filename-estrela', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY, {
      original_filename: 'vídeo final.mp4',
    });

    const res = await download(video, owner.accessToken);

    expect(res.status).toBe(302);
    const file = await followLocation(res.headers.location);
    expect(file.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''v%C3%ADdeo%20final.mp4`,
    );
  });

  // 2. Rejeições

  test('video-em-draft-retorna-409', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.DRAFT);

    const res = await download(video, owner.accessToken);

    expect(res.status).toBe(409);
    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');
  });

  test('outro-canal-retorna-404', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY);

    const res = await download(video, otherUser.accessToken);

    expect(res.status).toBe(404);
    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });

  test('sem-token-retorna-401', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY);

    const res = await download(video);

    expect(res.status).toBe(401);
  });
});
