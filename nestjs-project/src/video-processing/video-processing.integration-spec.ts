import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job, JobState, Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  startTestProcessor,
  type TestProcessor,
} from '../test/start-test-processor';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { MediaInspector } from './media-inspector.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

const FIXTURES_DIR = join(__dirname, '../../test/fixtures/media');
const WAIT_TIMEOUT_MS = 20_000;

jest.setTimeout(60_000);

describe('process-video pipeline (integration)', () => {
  let processor: TestProcessor;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let producer: VideoProcessingProducer;
  let storage: StorageService;
  let inspector: MediaInspector;
  let s3: S3Client;
  let channel: Channel;
  const createdKeys: { Bucket: string; Key: string }[] = [];

  beforeAll(async () => {
    processor = await startTestProcessor();
    dataSource = processor.module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = processor.module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    producer = processor.module.get(VideoProcessingProducer);
    storage = processor.module.get(StorageService);
    inspector = processor.module.get(MediaInspector);
    s3 = processor.module.get(S3_INTERNAL_CLIENT);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    for (const target of createdKeys) {
      await s3.send(new DeleteObjectCommand(target));
    }
    await processor.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: `worker-${randomUUID()}@example.com`, password: 'x' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Worker',
      nickname: `worker-${user.id.slice(0, 8)}`,
      user_id: user.id,
    });
  });

  async function uploadedVideo(
    fixture: string,
    contentType: string,
  ): Promise<Video> {
    const body = readFileSync(join(FIXTURES_DIR, fixture));
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        status: VideoStatus.PROCESSING,
        original_filename: fixture,
        content_type: contentType,
        size_bytes: body.length,
        upload_id: null,
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: 'videos-test',
        Key: video.id,
        Body: body,
      }),
    );
    createdKeys.push(
      { Bucket: 'videos-test', Key: video.id },
      { Bucket: 'thumbnails-test', Key: `${video.id}.jpg` },
    );
    return video;
  }

  async function waitFor<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting, last value: ${JSON.stringify(value)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function processAndWait(video: Video): Promise<Video> {
    await producer.enqueueProcessing(video.id);
    return waitFor(
      () => videoRepository.findOneByOrFail({ id: video.id }),
      (current) =>
        current.status === VideoStatus.READY ||
        current.status === VideoStatus.FAILED,
    );
  }

  async function finishedJob(jobId: string): Promise<Job> {
    const finalStates: JobState[] = ['completed', 'failed'];
    await waitFor(
      () => queue.getJobState(jobId),
      (state) => finalStates.includes(state as JobState),
    );
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    return job;
  }

  it('should bring an h264/aac MP4 to ready with its metadata and a public thumbnail', async () => {
    const video = await uploadedVideo('sample-h264-aac.mp4', 'video/mp4');

    const processed = await processAndWait(video);

    expect(processed).toMatchObject({
      status: VideoStatus.READY,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: `${video.id}.jpg`,
      failure_reason: null,
    });
    expect(processed.duration_seconds).toBeGreaterThan(0);

    const thumbnail = await fetch(
      storage.thumbnailPublicUrl(processed.thumbnail_key ?? ''),
    );
    const bytes = new Uint8Array(await thumbnail.arrayBuffer());
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('should bring a vp9/opus WebM to ready with a thumbnail', async () => {
    const video = await uploadedVideo('sample-vp9-opus.webm', 'video/webm');

    const processed = await processAndWait(video);

    expect(processed).toMatchObject({
      status: VideoStatus.READY,
      video_codec: 'vp9',
      audio_codec: 'opus',
      thumbnail_key: `${video.id}.jpg`,
    });
  });

  it('should fail an MPEG-4 Part 2 MP4 with UNSUPPORTED_CODEC after a single attempt and keep the original', async () => {
    const video = await uploadedVideo('sample-mpeg4.mp4', 'video/mp4');

    const processed = await processAndWait(video);
    const job = await finishedJob(video.id);

    expect(processed.status).toBe(VideoStatus.FAILED);
    expect(processed.failure_reason).toBe('UNSUPPORTED_CODEC');
    expect(job.attemptsMade).toBe(1);
    await expect(storage.headVideo(video.id)).resolves.toBeGreaterThan(0);
  });

  it('should fail a file that is not a video with INVALID_MEDIA after a single attempt', async () => {
    const video = await uploadedVideo('not-a-video.mp4', 'video/mp4');

    const processed = await processAndWait(video);
    const job = await finishedJob(video.id);

    expect(processed.status).toBe(VideoStatus.FAILED);
    expect(processed.failure_reason).toBe('INVALID_MEDIA');
    expect(job.attemptsMade).toBe(1);
  });

  it('should fail with PROCESSING_FAILED when a transient error persists over 3 attempts', async () => {
    const video = await uploadedVideo('sample-h264-aac.mp4', 'video/mp4');
    jest
      .spyOn(inspector, 'probe')
      .mockRejectedValue(new Error('connect ECONNREFUSED minio:9000'));

    const processed = await processAndWait(video);
    const job = await finishedJob(video.id);

    expect(processed.status).toBe(VideoStatus.FAILED);
    expect(processed.failure_reason).toBe('PROCESSING_FAILED');
    expect(job.attemptsMade).toBe(3);
  });

  it('should reach ready when a transient error goes away on the second attempt', async () => {
    const video = await uploadedVideo('sample-h264-aac.mp4', 'video/mp4');
    jest
      .spyOn(inspector, 'probe')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED minio:9000'));

    const processed = await processAndWait(video);
    const job = await finishedJob(video.id);

    expect(processed.status).toBe(VideoStatus.READY);
    expect(job.attemptsMade).toBe(2);
  });

  it('should not touch a video already ready when a duplicate job arrives', async () => {
    const video = await uploadedVideo('sample-h264-aac.mp4', 'video/mp4');
    const ready = await processAndWait(video);
    const probe = jest.spyOn(inspector, 'probe');

    const duplicateId = `${video.id}-duplicate`;
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      { jobId: duplicateId },
    );
    const job = await finishedJob(duplicateId);

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    expect(await job.getState()).toBe('completed');
    expect(probe).not.toHaveBeenCalled();
    expect(after.updated_at.getTime()).toBe(ready.updated_at.getTime());
  });
});
