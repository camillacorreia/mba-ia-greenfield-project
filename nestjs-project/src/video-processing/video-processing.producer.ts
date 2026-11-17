import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /** Idempotente: `jobId = videoId`, então um segundo enqueue do mesmo vídeo é ignorado. */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });
  }
}
