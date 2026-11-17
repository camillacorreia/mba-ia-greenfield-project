import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

// Só registra a fila e o producer. O consumer fica num módulo carregado apenas pelo
// entrypoint do worker, para que o processo da API nunca consuma jobs.
@Module({
  imports: [
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: PROCESS_VIDEO_JOB_OPTIONS,
    }),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class VideoProcessingQueueModule {}
