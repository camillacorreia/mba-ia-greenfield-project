import { randomUUID } from 'node:crypto';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { DraftExpiryService } from './draft-expiry.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR_MS = 60 * 60 * 1000;

describe('DraftExpiryService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: DraftExpiryService;
  let storage: StorageService;
  let s3: S3Client;
  let channel: Channel;
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoLifecycleService, DraftExpiryService],
    }).compile();
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    service = module.get(DraftExpiryService);
    storage = module.get(StorageService);
    s3 = module.get(S3_INTERNAL_CLIENT);
  });

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storage.abortVideoUpload(key, uploadId);
    }
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'drafts@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Drafts', nickname: 'drafts', user_id: user.id });
  });

  async function draftWithUpload(
    ageMs: number,
    status = VideoStatus.DRAFT,
  ): Promise<Video> {
    const id = randomUUID();
    // Diferente do id de propósito: a expiração aborta pela chave persistida.
    const storageKey = `stored/${id}`;
    const uploadId = await storage.createVideoUpload(storageKey, 'video/mp4');
    openUploads.push({ key: storageKey, uploadId });
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        public_id: generatePublicId(),
        title: 'abandoned',
        storage_key: storageKey,
        channel_id: channel.id,
        status,
        original_filename: 'abandoned.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        upload_id: uploadId,
      }),
    );
    await dataSource.query(
      'UPDATE "videos" SET "created_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - ageMs), id],
    );
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  async function listParts(video: Video): Promise<unknown> {
    return s3.send(
      new ListPartsCommand({
        Bucket: 'videos-test',
        Key: video.storage_key,
        UploadId: video.upload_id ?? '',
      }),
    );
  }

  it('should expire a 25h-old draft and abort its multipart', async () => {
    const old = await draftWithUpload(25 * HOUR_MS);

    await expect(service.expireDrafts()).resolves.toBe(1);

    const after = await videoRepository.findOneByOrFail({ id: old.id });
    expect(after.status).toBe(VideoStatus.FAILED);
    expect(after.failure_reason).toBe('UPLOAD_EXPIRED');
    await expect(listParts(old)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('should leave a 1h-old draft and a 25h-old processing video untouched', async () => {
    const recent = await draftWithUpload(HOUR_MS);
    const processing = await draftWithUpload(
      25 * HOUR_MS,
      VideoStatus.PROCESSING,
    );

    await expect(service.expireDrafts()).resolves.toBe(0);

    const recentAfter = await videoRepository.findOneByOrFail({
      id: recent.id,
    });
    const processingAfter = await videoRepository.findOneByOrFail({
      id: processing.id,
    });
    expect(recentAfter.status).toBe(VideoStatus.DRAFT);
    await expect(listParts(recent)).resolves.toBeDefined();
    expect(processingAfter).toMatchObject({
      status: VideoStatus.PROCESSING,
      failure_reason: null,
    });
    expect(processingAfter.updated_at.getTime()).toBe(
      processing.updated_at.getTime(),
    );
  });

  it('should expire a draft whose multipart was already aborted by the storage', async () => {
    const old = await draftWithUpload(25 * HOUR_MS);
    await storage.abortVideoUpload(old.storage_key, old.upload_id ?? '');

    await expect(service.expireDrafts()).resolves.toBe(1);

    const after = await videoRepository.findOneByOrFail({ id: old.id });
    expect(after.failure_reason).toBe('UPLOAD_EXPIRED');
  });

  it('should change nothing when run twice in a row', async () => {
    const old = await draftWithUpload(25 * HOUR_MS);
    await service.expireDrafts();
    const afterFirst = await videoRepository.findOneByOrFail({ id: old.id });

    await expect(service.expireDrafts()).resolves.toBe(0);

    const afterSecond = await videoRepository.findOneByOrFail({ id: old.id });
    expect(afterSecond.updated_at.getTime()).toBe(
      afterFirst.updated_at.getTime(),
    );
  });
});
