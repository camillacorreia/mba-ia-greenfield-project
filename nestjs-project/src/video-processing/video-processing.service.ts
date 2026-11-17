import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import type { VideoFailureReason } from '../videos/video-metadata.types';
import { checkPlayability, thumbnailTimestamp } from './codec-policy';
import {
  MediaInspector,
  MediaUnreadableError,
  type ProbeResult,
} from './media-inspector.service';

/** URL interna lida pelo ffprobe/ffmpeg dentro da rede do Compose (TD-05). */
const PROCESSING_READ_URL_EXPIRES_IN_SECONDS = 900;
const FAILABLE_STATUSES = [VideoStatus.DRAFT, VideoStatus.PROCESSING];

@Injectable()
export class VideoProcessingService {
  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    private readonly inspector: MediaInspector,
  ) {}

  /**
   * Erro permanente (arquivo ilegível, container ou codec fora da allowlist) marca
   * `failed` na hora e lança `UnrecoverableError`, sem retry. Qualquer outro erro
   * sobe como transitório e o BullMQ tenta de novo (TD-09). O original nunca é
   * apagado do bucket.
   */
  async process(videoId: string): Promise<void> {
    const video = await this.lifecycle.findById(videoId);
    if (
      !video ||
      video.status === VideoStatus.READY ||
      video.status === VideoStatus.FAILED
    ) {
      return;
    }

    const url = await this.storage.presignVideoGet(video.storage_key, {
      signer: 'internal',
      expiresIn: PROCESSING_READ_URL_EXPIRES_IN_SECONDS,
    });

    let probe: ProbeResult;
    try {
      probe = await this.inspector.probe(url);
    } catch (error) {
      if (error instanceof MediaUnreadableError) {
        return this.failPermanently(video.id, 'INVALID_MEDIA');
      }
      throw error;
    }

    const verdict = checkPlayability(video.content_type, probe);
    if (verdict !== 'ok' || !probe.video || !probe.durationSeconds) {
      return this.failPermanently(
        video.id,
        verdict === 'ok' ? 'INVALID_MEDIA' : verdict,
      );
    }

    const frame = await this.inspector.extractFrame(
      url,
      thumbnailTimestamp(probe.durationSeconds),
    );
    const thumbnailKey = `${video.id}.jpg`;
    await this.storage.putThumbnail(thumbnailKey, frame);

    await this.lifecycle.markReady(video.id, {
      duration_seconds: probe.durationSeconds,
      width: probe.video.width,
      height: probe.video.height,
      video_codec: probe.video.codec,
      audio_codec: probe.audio?.codec ?? null,
      thumbnail_key: thumbnailKey,
    });
  }

  private async failPermanently(
    videoId: string,
    reason: VideoFailureReason,
  ): Promise<never> {
    await this.lifecycle.markFailed(videoId, reason, FAILABLE_STATUSES);
    throw new UnrecoverableError(reason);
  }
}
