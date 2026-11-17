import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { type AuthenticatedUser, VideosE2eContext } from './helpers/videos-e2e';

interface PartUrlsBody {
  parts: { part_number: number; url: string }[];
  expires_in: number;
}

describe('videos-upload-part-urls', () => {
  const ctx = new VideosE2eContext();
  let owner: AuthenticatedUser;
  let otherUser: AuthenticatedUser;
  let publicId: string;

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
    const created = await request(ctx.server())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ filename: 'aula.mp4', size: 5000000, content_type: 'video/mp4' })
      .expect(201);
    publicId = (created.body as { public_id: string }).public_id;
  });

  function requestPartUrls(id: string, body: object, token: string) {
    return request(ctx.server())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function errorOf(res: request.Response): string {
    return (res.body as ApiErrorEnvelope).error;
  }

  // 1. Emitir URLs de envio das partes

  test('emite-url-assinada-que-aceita-a-parte', async () => {
    const res = await requestPartUrls(
      publicId,
      { part_numbers: [1] },
      owner.accessToken,
    );

    expect(res.status).toBe(200);
    const body = res.body as PartUrlsBody;
    expect(body.expires_in).toBe(3600);
    expect(body.parts[0].part_number).toBe(1);
    expect(new URL(body.parts[0].url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT ?? '').host,
    );

    const put = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(1024),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  // 2. Rejeições

  test('parte-acima-do-part-count-retorna-400', async () => {
    const res = await requestPartUrls(
      publicId,
      { part_numbers: [2] },
      owner.accessToken,
    );

    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('INVALID_PART_NUMBER');
  });

  test('outro-canal-e-public-id-inexistente-retornam-404', async () => {
    const fromOtherChannel = await requestPartUrls(
      publicId,
      { part_numbers: [1] },
      otherUser.accessToken,
    );
    const unknown = await requestPartUrls(
      'abc',
      { part_numbers: [1] },
      owner.accessToken,
    );

    expect(fromOtherChannel.status).toBe(404);
    expect(errorOf(fromOtherChannel)).toBe('VIDEO_NOT_FOUND');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(fromOtherChannel.body);
  });

  test('video-fora-de-draft-retorna-409', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, { status: VideoStatus.PROCESSING });

    const res = await requestPartUrls(
      publicId,
      { part_numbers: [1] },
      owner.accessToken,
    );

    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('VIDEO_NOT_DRAFT');
  });

  test('part-numbers-vazio-ou-repetido-retorna-400', async () => {
    const empty = await requestPartUrls(
      publicId,
      { part_numbers: [] },
      owner.accessToken,
    );
    const repeated = await requestPartUrls(
      publicId,
      { part_numbers: [1, 1] },
      owner.accessToken,
    );

    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toBe('VALIDATION_ERROR');
    expect(repeated.status).toBe(400);
    expect(errorOf(repeated)).toBe('VALIDATION_ERROR');
  });
});
