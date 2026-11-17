import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { DraftExpiryScheduler } from './draft-expiry.scheduler';
import { DraftExpiryService } from './draft-expiry.service';
import { MediaInspector } from './media-inspector.service';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

/**
 * Consumer da fila. Carregado só pelo entrypoint do worker (e pelo processor dos
 * testes); o AppModule não importa este módulo, então a API nunca consome jobs.
 */
@Module({
  imports: [VideosModule, StorageModule, VideoProcessingQueueModule],
  providers: [
    MediaInspector,
    VideoProcessingService,
    VideoProcessor,
    DraftExpiryService,
    DraftExpiryScheduler,
  ],
})
export class VideoProcessingModule {}
