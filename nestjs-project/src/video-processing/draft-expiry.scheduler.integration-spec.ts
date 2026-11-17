import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { bullRootOptions } from '../queue/bull-root.options';
import {
  DraftExpiryScheduler,
  EXPIRE_DRAFTS_EVERY_MS,
} from './draft-expiry.scheduler';
import {
  EXPIRE_DRAFTS_JOB,
  EXPIRE_DRAFTS_SCHEDULER_ID,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';

async function bootstrapScheduler(): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      BullModule.forRootAsync({
        inject: [queueConfig.KEY],
        useFactory: bullRootOptions,
      }),
      VideoProcessingQueueModule,
    ],
    providers: [DraftExpiryScheduler],
  }).compile();
  // `init()` dispara o `onApplicationBootstrap`, como no boot do worker.
  await module.init();
  return module;
}

describe('DraftExpiryScheduler (integration)', () => {
  let first: TestingModule;
  let second: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    first = await bootstrapScheduler();
    queue = first.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await second?.close();
    await first.close();
  });

  it('should keep a single expire-draft-uploads scheduler across two bootstraps', async () => {
    await first.get(DraftExpiryScheduler).onApplicationBootstrap();
    second = await bootstrapScheduler();

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: EXPIRE_DRAFTS_SCHEDULER_ID,
      name: EXPIRE_DRAFTS_JOB,
      every: EXPIRE_DRAFTS_EVERY_MS,
    });
    expect(EXPIRE_DRAFTS_EVERY_MS).toBe(3600000);
  });
});
