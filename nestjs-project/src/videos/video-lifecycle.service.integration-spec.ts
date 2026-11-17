import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoLifecycleService } from './video-lifecycle.service';
import type { VideoMetadata } from './video-metadata.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const METADATA: VideoMetadata = {
  duration_seconds: 12.5,
  width: 1280,
  height: 720,
  video_codec: 'h264',
  audio_codec: 'aac',
  thumbnail_key: 'thumb.jpg',
};

describe('VideoLifecycleService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let lifecycle: VideoLifecycleService;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    lifecycle = new VideoLifecycleService(videoRepository);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'lifecycle@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Lifecycle', nickname: 'lifecycle', user_id: user.id });
  });

  async function createVideo(
    status: VideoStatus,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        title: 'clip',
        storage_key: `stored/${generatePublicId()}`,
        channel_id: channel.id,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        upload_id: 'upload-id',
        status,
        failure_reason: status === VideoStatus.FAILED ? 'INVALID_MEDIA' : null,
        ...overrides,
      }),
    );
  }

  async function reload(id: string): Promise<Video> {
    return videoRepository.findOneByOrFail({ id });
  }

  async function backdate(id: string, createdAt: Date): Promise<void> {
    await dataSource.query(
      'UPDATE "videos" SET "created_at" = $1 WHERE "id" = $2',
      [createdAt, id],
    );
  }

  describe('reads', () => {
    it('should find a video by id and by public id', async () => {
      const video = await createVideo(VideoStatus.DRAFT);

      expect((await lifecycle.findById(video.id))?.public_id).toBe(
        video.public_id,
      );
      expect((await lifecycle.findByPublicId(video.public_id))?.id).toBe(
        video.id,
      );
    });

    it('should return null for unknown ids', async () => {
      await expect(
        lifecycle.findById('00000000-0000-4000-8000-000000000000'),
      ).resolves.toBeNull();
      await expect(
        lifecycle.findByPublicId(generatePublicId()),
      ).resolves.toBeNull();
    });
  });

  describe('markProcessing', () => {
    it('should move a draft to processing and clear upload_id', async () => {
      const video = await createVideo(VideoStatus.DRAFT);

      await expect(lifecycle.markProcessing(video.id)).resolves.toBe(true);

      const after = await reload(video.id);
      expect(after.status).toBe(VideoStatus.PROCESSING);
      expect(after.upload_id).toBeNull();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should be a no-op from %s',
      async (status) => {
        const video = await createVideo(status);

        await expect(lifecycle.markProcessing(video.id)).resolves.toBe(false);

        const after = await reload(video.id);
        expect(after.status).toBe(status);
        expect(after.upload_id).toBe('upload-id');
      },
    );
  });

  describe('markReady', () => {
    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING])(
      'should move a video in %s to ready with its metadata',
      async (status) => {
        const video = await createVideo(status);

        await expect(lifecycle.markReady(video.id, METADATA)).resolves.toBe(
          true,
        );

        const after = await reload(video.id);
        expect(after.status).toBe(VideoStatus.READY);
        expect(after).toMatchObject(METADATA);
      },
    );

    it('should be a no-op from ready', async () => {
      const video = await createVideo(VideoStatus.READY);

      await expect(lifecycle.markReady(video.id, METADATA)).resolves.toBe(
        false,
      );
      expect((await reload(video.id)).thumbnail_key).toBeNull();
    });

    it('should be a no-op from failed and keep failure_reason', async () => {
      const video = await createVideo(VideoStatus.FAILED);

      await expect(lifecycle.markReady(video.id, METADATA)).resolves.toBe(
        false,
      );

      const after = await reload(video.id);
      expect(after.status).toBe(VideoStatus.FAILED);
      expect(after.failure_reason).toBe('INVALID_MEDIA');
    });
  });

  describe('markFailed', () => {
    it.each([
      [VideoStatus.DRAFT, [VideoStatus.DRAFT]],
      [VideoStatus.PROCESSING, [VideoStatus.DRAFT, VideoStatus.PROCESSING]],
    ])(
      'should move a video in %s to failed with the reason',
      async (status, fromStatuses) => {
        const video = await createVideo(status);

        await expect(
          lifecycle.markFailed(video.id, 'UNSUPPORTED_CODEC', fromStatuses),
        ).resolves.toBe(true);

        const after = await reload(video.id);
        expect(after.status).toBe(VideoStatus.FAILED);
        expect(after.failure_reason).toBe('UNSUPPORTED_CODEC');
      },
    );

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should not expire a video in %s when only draft is allowed',
      async (status) => {
        const video = await createVideo(status);

        await expect(
          lifecycle.markFailed(video.id, 'UPLOAD_EXPIRED', [VideoStatus.DRAFT]),
        ).resolves.toBe(false);

        const after = await reload(video.id);
        expect(after.status).toBe(status);
        expect(after.failure_reason).not.toBe('UPLOAD_EXPIRED');
      },
    );

    it('should be a no-op with an empty list of origin statuses', async () => {
      const video = await createVideo(VideoStatus.DRAFT);

      await expect(
        lifecycle.markFailed(video.id, 'PROCESSING_FAILED', []),
      ).resolves.toBe(false);
      expect((await reload(video.id)).status).toBe(VideoStatus.DRAFT);
    });
  });

  describe('findExpiredDrafts', () => {
    it('should return only drafts created before the cutoff', async () => {
      const cutoff = new Date('2026-11-16T12:00:00Z');
      const before = new Date('2026-11-16T11:59:59Z');
      const expired = await createVideo(VideoStatus.DRAFT);
      const recent = await createVideo(VideoStatus.DRAFT);
      const oldProcessing = await createVideo(VideoStatus.PROCESSING);
      const oldFailed = await createVideo(VideoStatus.FAILED);
      await backdate(expired.id, before);
      await backdate(recent.id, new Date('2026-11-16T12:00:01Z'));
      await backdate(oldProcessing.id, before);
      await backdate(oldFailed.id, before);

      const found = await lifecycle.findExpiredDrafts(cutoff);

      expect(found.map((video) => video.id)).toEqual([expired.id]);
    });
  });
});
