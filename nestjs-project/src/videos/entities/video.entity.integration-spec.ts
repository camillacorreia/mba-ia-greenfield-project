import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<{ user: User; channel: Channel }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video-channel-${n}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channelId,
      original_filename: 'holiday.mp4',
      content_type: 'video/mp4',
      size_bytes: 10 * 1024 * 1024,
      upload_id: 'multipart-upload-id',
      ...overrides,
    });
  }

  it('should default status to draft when not provided', async () => {
    const { channel } = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should read size_bytes back as a number', async () => {
    const { channel } = await createChannel();
    const tenGiB = 10737418240;

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: tenGiB }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(tenGiB);
  });

  it('should enforce unique public_id', async () => {
    const { channel } = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow(/duplicate key/);
  });

  it('should reject a status outside the enum', async () => {
    const { channel } = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { status: 'archived' as VideoStatus }),
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('should reject a video without channel_id', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "original_filename", "content_type", "size_bytes")
         VALUES ($1, 'a.mp4', 'video/mp4', 1)`,
        [generatePublicId()],
      ),
    ).rejects.toThrow(/null value in column "channel_id"/);
  });

  it('should delete the videos when their channel is deleted', async () => {
    const { channel } = await createChannel();
    await videoRepository.save(buildVideo(channel.id));
    await videoRepository.save(buildVideo(channel.id));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
  });

  it('should keep blocking the deletion of a user that still has a channel', async () => {
    const { user, channel } = await createChannel();
    await videoRepository.save(buildVideo(channel.id));

    await expect(userRepository.delete({ id: user.id })).rejects.toThrow(
      /foreign key constraint/,
    );
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const { channel } = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found.channel.nickname).toBe(channel.nickname);
  });
});
