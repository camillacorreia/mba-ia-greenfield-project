import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { type AuthenticatedUser, VideosE2eContext } from './helpers/videos-e2e';

interface InitiateUploadBody {
  public_id: string;
  status: string;
  part_size: number;
  part_count: number;
}

const VALID_BODY = {
  filename: 'aula.mp4',
  size: 5000000,
  content_type: 'video/mp4',
};

describe('videos-initiate-upload', () => {
  const ctx = new VideosE2eContext();
  let userA: AuthenticatedUser;

  beforeAll(async () => {
    await ctx.init();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    userA = await ctx.registerConfirmAndLogin('user-a@example.com');
  });

  function postVideos(body: object, token?: string) {
    const req = request(ctx.server()).post('/videos');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  }

  async function videoCount(): Promise<number> {
    return ctx.dataSource.getRepository(Video).count();
  }

  // 1. Iniciar upload e criar rascunho

  test('cria-rascunho-com-plano-de-partes', async () => {
    const res = await postVideos(VALID_BODY, userA.accessToken);

    expect(res.status).toBe(201);
    const body = res.body as InitiateUploadBody;
    expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body).toMatchObject({
      status: 'draft',
      part_size: 104857600,
      part_count: 1,
    });
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('channel_id');
    expect(body).not.toHaveProperty('upload_id');

    const user = await ctx.dataSource
      .getRepository(User)
      .findOneByOrFail({ email: userA.email });
    const channel = await ctx.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    const video = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: body.public_id });
    expect(video).toMatchObject({
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      original_filename: 'aula.mp4',
      size_bytes: 5000000,
    });
    expect(video.upload_id).not.toBeNull();

    const s3 = ctx.app.get<S3Client>(S3_INTERNAL_CLIENT);
    const parts = await s3.send(
      new ListPartsCommand({
        Bucket: 'videos-test',
        Key: video.id,
        UploadId: video.upload_id ?? '',
      }),
    );
    expect(parts.UploadId).toBe(video.upload_id);
  });

  test('tamanho-maximo-de-10-gib', async () => {
    const res = await postVideos(
      { filename: 'longo.mp4', size: 10737418240, content_type: 'video/mp4' },
      userA.accessToken,
    );

    expect(res.status).toBe(201);
    expect((res.body as InitiateUploadBody).part_count).toBe(103);
  });

  // 2. Rejeições de domínio, validação e autenticação

  test('acima-de-10-gib-retorna-413', async () => {
    const res = await postVideos(
      { filename: 'grande.mp4', size: 10737418241, content_type: 'video/mp4' },
      userA.accessToken,
    );

    expect(res.status).toBe(413);
    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_TOO_LARGE');
    await expect(videoCount()).resolves.toBe(0);
  });

  test('formato-fora-da-allowlist-retorna-415', async () => {
    const res = await postVideos(
      { filename: 'aula.mov', size: 5000000, content_type: 'video/quicktime' },
      userA.accessToken,
    );

    expect(res.status).toBe(415);
    expect((res.body as ApiErrorEnvelope).error).toBe(
      'UNSUPPORTED_VIDEO_FORMAT',
    );
    await expect(videoCount()).resolves.toBe(0);
  });

  test('body-invalido-retorna-400', async () => {
    const res = await postVideos(
      { size: 5000000, content_type: 'video/mp4' },
      userA.accessToken,
    );

    expect(res.status).toBe(400);
    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
  });

  test('sem-token-retorna-401', async () => {
    const res = await postVideos(VALID_BODY);

    expect(res.status).toBe(401);
    await expect(videoCount()).resolves.toBe(0);
  });
});
