import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { Channel } from '../../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import queueConfig from '../../src/config/queue.config';
import storageConfig from '../../src/config/storage.config';
import { bullRootOptions } from '../../src/queue/bull-root.options';
import { S3_INTERNAL_CLIENT } from '../../src/storage/storage.constants';
import { StorageService } from '../../src/storage/storage.service';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import { Video, VideoStatus } from '../../src/videos/entities/video.entity';
import { generatePublicId } from '../../src/videos/public-id.util';
import { User } from '../../src/users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../../src/video-processing/video-processing.constants';

/** Fixture MP4 h264/aac da SI-03.10. */
export const SAMPLE_MP4 = readFileSync(
  join(__dirname, '../fixtures/media/sample-h264-aac.mp4'),
);

export interface UploadedDraft {
  publicId: string;
  etag: string;
}

export interface AuthenticatedUser {
  email: string;
  accessToken: string;
}

/**
 * Setup comum dos e2e de vídeo: AppModule com a config global do `main.ts`,
 * usuários pelo fluxo da fase 02 (register → confirmação → login) e limpeza do
 * Postgres, da fila de teste e dos multiparts abertos no storage.
 */
export class VideosE2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  /** Fila `video-processing` no prefixo de teste, para asserts e limpeza. */
  queue: Queue;
  private throttlerStorage: ThrottlerStorageService;

  async init(): Promise<void> {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    this.app = moduleFixture.createNestApplication();
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    this.app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await this.app.init();
    this.dataSource = moduleFixture.get(DataSource);
    this.throttlerStorage = moduleFixture.get(ThrottlerStorage);
    this.queue = new Queue(
      VIDEO_PROCESSING_QUEUE,
      bullRootOptions(queueConfig()),
    );
  }

  async reset(): Promise<void> {
    await this.cleanStorage();
    await cleanAllTables(this.dataSource);
    await this.queue.obliterate({ force: true });
    this.throttlerStorage.storage.clear();
  }

  async close(): Promise<void> {
    await this.cleanStorage();
    await this.queue.close();
    await this.app.close();
  }

  server(): App {
    return this.app.getHttpServer();
  }

  async registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<AuthenticatedUser> {
    const authService = this.app.get(AuthService);
    let confirmationToken = '';
    jest
      .spyOn(authService['mailService'], 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, token: string) => {
        confirmationToken = token;
        return Promise.resolve();
      });
    await request(this.server())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(this.server())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(this.server())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const { access_token } = login.body as { access_token: string };
    return { email, accessToken: access_token };
  }

  /**
   * Semeia um vídeo direto no banco, no canal do usuário, sem passar pelo upload
   * nem pelo worker. Em `ready`, grava a fixture MP4 na chave `{id}` do bucket.
   */
  async seedVideo(
    user: AuthenticatedUser,
    status: VideoStatus,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const owner = await this.dataSource
      .getRepository(User)
      .findOneByOrFail({ email: user.email });
    const channel = await this.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: owner.id });
    const isReady = status === VideoStatus.READY;
    const repository = this.dataSource.getRepository(Video);
    const video = await repository.save(
      repository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        status,
        original_filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: SAMPLE_MP4.length,
        upload_id: null,
        ...(isReady && {
          duration_seconds: 1.534,
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
        }),
        ...overrides,
      }),
    );
    if (isReady) {
      await this.app.get<S3Client>(S3_INTERNAL_CLIENT).send(
        new PutObjectCommand({
          Bucket: storageConfig().bucketVideos,
          Key: video.id,
          Body: SAMPLE_MP4,
          ContentType: video.content_type,
        }),
      );
    }
    return video;
  }

  /**
   * Cria o rascunho por `POST /videos` e envia `bytes` como parte 1 pela URL
   * assinada. `declaredSize` permite declarar um tamanho diferente do enviado.
   */
  async createDraftWithUploadedPart(
    user: AuthenticatedUser,
    bytes: Uint8Array<ArrayBuffer>,
    options: { declaredSize?: number; contentType?: string } = {},
  ): Promise<UploadedDraft> {
    const created = await request(this.server())
      .post('/videos')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        filename: 'aula.mp4',
        size: options.declaredSize ?? bytes.length,
        content_type: options.contentType ?? 'video/mp4',
      })
      .expect(201);
    const { public_id: publicId } = created.body as { public_id: string };
    const partUrls = await request(this.server())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const { parts } = partUrls.body as { parts: { url: string }[] };
    const put = await fetch(parts[0].url, { method: 'PUT', body: bytes });
    if (put.status !== 200) {
      throw new Error(`Part upload failed with status ${put.status}`);
    }
    return { publicId, etag: put.headers.get('etag') ?? '' };
  }

  /**
   * Para cada vídeo da suíte: aborta o multipart ainda aberto e apaga o objeto
   * final e a thumbnail, para não deixar lixo nos buckets de teste.
   */
  private async cleanStorage(): Promise<void> {
    const storage = this.app.get(StorageService);
    const s3 = this.app.get<S3Client>(S3_INTERNAL_CLIENT);
    const { bucketVideos, bucketThumbnails } = storageConfig();
    const videos = await this.dataSource.getRepository(Video).find();
    for (const video of videos) {
      if (video.upload_id) {
        await storage.abortVideoUpload(video.id, video.upload_id);
      }
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucketVideos, Key: video.id }),
      );
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketThumbnails,
          Key: `${video.id}.jpg`,
        }),
      );
    }
  }
}
