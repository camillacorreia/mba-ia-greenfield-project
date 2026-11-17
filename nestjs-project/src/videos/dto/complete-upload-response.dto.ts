import { VideoStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  /** @example "dQw4w9WgXcQ" */
  public_id: string;

  /** @example "processing" */
  status: VideoStatus;
}
