import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { bullRootOptions } from '../queue/bull-root.options';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingQueueModule', () => {
  it('should compile with queueConfig and provide the queue and the producer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: bullRootOptions,
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingProducer)).toBeDefined();
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    await module.close();
  });
});
