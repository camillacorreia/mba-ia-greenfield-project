import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { type AuthenticatedUser, VideosE2eContext } from './helpers/videos-e2e';

describe('videos-stream', () => {
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

  function stream(video: Video, token?: string) {
    const req = request(ctx.server()).get(`/videos/${video.public_id}/stream`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.redirects(0);
  }

  // 1. Redirecionar para streaming

  test('ready-redireciona-para-url-assinada', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY);

    const res = await stream(video, owner.accessToken);

    expect(res.status).toBe(302);
    expect(res.text ?? '').toBe('');
    const location = new URL(res.headers.location);
    expect(location.host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT ?? '').host,
    );
    expect(location.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  test('location-atende-range-com-206', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY);
    const res = await stream(video, owner.accessToken);

    const ranged = await fetch(res.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    await ranged.arrayBuffer();

    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${video.size_bytes}`,
    );
    expect(ranged.headers.get('content-type')).toBe('video/mp4');
  });

  // 2. Rejeições

  test('video-em-processing-retorna-409', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.PROCESSING);

    const res = await stream(video, owner.accessToken);

    expect(res.status).toBe(409);
    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');
  });

  test('outro-canal-retorna-404', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY);

    const res = await stream(video, otherUser.accessToken);

    expect(res.status).toBe(404);
    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
    expect(res.headers.location).toBeUndefined();
  });

  test('sem-token-retorna-401', async () => {
    const video = await ctx.seedVideo(owner, VideoStatus.READY);

    const res = await stream(video);

    expect(res.status).toBe(401);
  });
});
