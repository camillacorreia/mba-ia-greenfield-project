import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let s3: S3Client;
  let user: User;
  let channel: Channel;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    s3 = module.get(S3_INTERNAL_CLIENT);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Uploader', nickname: 'uploader', user_id: user.id });
  });

  it('should store a draft in the user channel with an upload accepted by the storage', async () => {
    const result = await videosService.initiateUpload(user.id, {
      filename: 'aula.mp4',
      size: 5000000,
      content_type: 'video/mp4',
    });

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.public_id });
    expect(video).toMatchObject({
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 5000000,
    });
    expect(video.upload_id).toEqual(expect.any(String));

    const parts = await s3.send(
      new ListPartsCommand({
        Bucket: 'videos-test',
        Key: video.id,
        UploadId: video.upload_id ?? '',
      }),
    );
    expect(parts.$metadata.httpStatusCode).toBe(200);

    await storageService.abortVideoUpload(video.id, video.upload_id ?? '');
  });

  it('should not create a row nor touch the storage for a user without channel', async () => {
    await dataSource.query('DELETE FROM "channels"');
    const createUpload = jest.spyOn(storageService, 'createVideoUpload');

    await expect(
      videosService.initiateUpload(user.id, {
        filename: 'aula.mp4',
        size: 5000000,
        content_type: 'video/mp4',
      }),
    ).rejects.toMatchObject({ errorCode: 'CHANNEL_NOT_FOUND' });
    expect(createUpload).not.toHaveBeenCalled();
    await expect(dataSource.getRepository(Video).count()).resolves.toBe(0);
    createUpload.mockRestore();
  });

  it('should abort the opened multipart when the draft insert fails', async () => {
    const insert = jest
      .spyOn(dataSource.getRepository(Video), 'insert')
      .mockRejectedValueOnce(new Error('insert failed'));
    const createUpload = jest.spyOn(storageService, 'createVideoUpload');

    await expect(
      videosService.initiateUpload(user.id, {
        filename: 'aula.mp4',
        size: 5000000,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow('insert failed');

    const [key] = createUpload.mock.calls[0];
    const uploadId = (await createUpload.mock.results[0].value) as string;
    await expect(
      s3.send(
        new ListPartsCommand({
          Bucket: 'videos-test',
          Key: key,
          UploadId: uploadId,
        }),
      ),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    insert.mockRestore();
    createUpload.mockRestore();
  });

  it('should return part URLs that accept the PUT of a part and answer with an ETag', async () => {
    const created = await videosService.initiateUpload(user.id, {
      filename: 'aula.mp4',
      size: 5000000,
      content_type: 'video/mp4',
    });

    const result = await videosService.requestPartUrls(
      user.id,
      created.public_id,
      { part_numbers: [1] },
    );
    const response = await fetch(result.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(1024),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: created.public_id });
    await storageService.abortVideoUpload(video.id, video.upload_id ?? '');
  });
});
