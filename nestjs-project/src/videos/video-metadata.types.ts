export interface VideoMetadata {
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  thumbnail_key: string;
}

export const VIDEO_FAILURE_REASONS = [
  'UPLOAD_SIZE_MISMATCH',
  'UPLOAD_EXPIRED',
  'INVALID_MEDIA',
  'UNSUPPORTED_CONTAINER',
  'UNSUPPORTED_CODEC',
  'PROCESSING_FAILED',
] as const;

export type VideoFailureReason = (typeof VIDEO_FAILURE_REASONS)[number];
