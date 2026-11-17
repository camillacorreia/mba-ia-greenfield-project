import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';

const UNRECOVERABLE_ERROR_NAME = 'UnrecoverableError';

/** Consumer da fila `video-processing`; registrado só pelo entrypoint do worker. */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly processing: VideoProcessingService,
    private readonly lifecycle: VideoLifecycleService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case PROCESS_VIDEO_JOB:
        return this.processing.process(
          (job.data as ProcessVideoJobData).videoId,
        );
      default:
        throw new UnrecoverableError(`Unknown job name: ${job.name}`);
    }
  }

  /**
   * Erro transitório que persistiu até a última tentativa vira PROCESSING_FAILED.
   * O evento é emitido a cada tentativa, com `attemptsMade` já incrementado; erros
   * permanentes já marcaram `failed` dentro do próprio job.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) return;
    if (error.name === UNRECOVERABLE_ERROR_NAME) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;

    const { videoId } = job.data as ProcessVideoJobData;
    this.logger.error(
      `process-video for ${videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
    await this.lifecycle.markFailed(videoId, 'PROCESSING_FAILED', [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
    ]);
  }
}
