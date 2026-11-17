import type { VideoResponseDto } from './dto/video-response.dto';
import type { Video } from './entities/video.entity';

/**
 * Formato público do vídeo. Lista os campos explicitamente para que `id`,
 * `channel_id`, `upload_id` e `storage_key` nunca vazem, mesmo se a entidade ganhar colunas.
 */
export function toVideoResponse(
  video: Video,
  thumbnailUrlFor: (key: string) => string,
): VideoResponseDto {
  return {
    public_id: video.public_id,
    title: video.title,
    status: video.status,
    failure_reason: video.failure_reason,
    original_filename: video.original_filename,
    content_type: video.content_type,
    size_bytes: Number(video.size_bytes),
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    thumbnail_url: video.thumbnail_key
      ? thumbnailUrlFor(video.thumbnail_key)
      : null,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
