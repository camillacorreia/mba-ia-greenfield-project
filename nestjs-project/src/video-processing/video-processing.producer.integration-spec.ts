import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import queueConfig from '../config/queue.config';
import { bullRootOptions } from '../queue/bull-root.options';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;
  let redis: Redis;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: bullRootOptions,
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await redis.quit();
    await module.close();
  });

  it('should enqueue a process-video job identified by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    const job = await queue.getJob(videoId);

    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId });
  });

  it('should apply 3 attempts with exponential backoff to the job', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    const job = await queue.getJob(videoId);

    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    expect(counts.waiting + counts.active + counts.delayed).toBe(1);
  });

  it('should store the job keys under the test prefix', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    expect(queue.toKey(videoId)).toBe(
      `streamtube-test:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
    );
    await expect(redis.exists(queue.toKey(videoId))).resolves.toBe(1);
    await expect(
      redis.exists(`streamtube:${VIDEO_PROCESSING_QUEUE}:${videoId}`),
    ).resolves.toBe(0);
  });

  it('should leave the job waiting because the API registers no consumer', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(queue.getJobState(videoId)).resolves.toBe('waiting');
  });
});
