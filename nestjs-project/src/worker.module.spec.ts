import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from './video-processing/video-processing.constants';
import { VideoProcessor } from './video-processing/video.processor';
import { Video } from './videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with config, TypeORM, BullMQ and the video processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    expect(module.get(DataSource).hasMetadata(Video)).toBe(true);
    await module.close();
  }, 30000);
});
