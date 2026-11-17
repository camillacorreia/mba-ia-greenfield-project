import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  /** @example "dQw4w9WgXcQ" */
  public_id: string;

  /** @example "Aula 1: introdução" */
  title: string;

  /** @example "ready" */
  status: VideoStatus;

  /**
   * Motivo da falha quando `status = failed`.
   * @example null
   */
  failure_reason: string | null;

  /** @example "aula.mp4" */
  original_filename: string;

  /** @example "video/mp4" */
  content_type: string;

  /** @example 5000000 */
  size_bytes: number;

  /** @example 12.5 */
  duration_seconds: number | null;

  /** @example 1280 */
  width: number | null;

  /** @example 720 */
  height: number | null;

  /** @example "h264" */
  video_codec: string | null;

  /** @example "aac" */
  audio_codec: string | null;

  /**
   * URL pública da thumbnail, null até o processamento gerar uma.
   * @example "http://localhost:9000/thumbnails/6f1c1b7e-3f0a-4c55-9d4e-2b8f1a6c9e10.jpg"
   */
  thumbnail_url: string | null;

  /** @example "2026-11-17T12:00:00.000Z" */
  created_at: string;

  /** @example "2026-11-17T12:00:05.000Z" */
  updated_at: string;
}
