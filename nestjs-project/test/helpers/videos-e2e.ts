import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import queueConfig from '../../src/config/queue.config';
import { bullRootOptions } from '../../src/queue/bull-root.options';
import { StorageService } from '../../src/storage/storage.service';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import { Video } from '../../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../../src/video-processing/video-processing.constants';

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
  private queue: Queue;
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
    await this.abortOpenUploads();
    await cleanAllTables(this.dataSource);
    await this.queue.obliterate({ force: true });
    this.throttlerStorage.storage.clear();
  }

  async close(): Promise<void> {
    await this.abortOpenUploads();
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

  /** Aborta os multiparts dos rascunhos para não deixar uploads órfãos no bucket de teste. */
  private async abortOpenUploads(): Promise<void> {
    const storage = this.app.get(StorageService);
    const drafts = await this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .where('video.upload_id IS NOT NULL')
      .getMany();
    for (const draft of drafts) {
      await storage.abortVideoUpload(draft.id, draft.upload_id ?? '');
    }
  }
}
