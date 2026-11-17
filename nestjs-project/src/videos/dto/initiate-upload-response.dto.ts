import { VideoStatus } from '../entities/video.entity';

export class InitiateUploadResponseDto {
  /**
   * ID público do vídeo (11 caracteres base64url), usado em todas as rotas.
   * @example "dQw4w9WgXcQ"
   */
  public_id: string;

  /** @example "draft" */
  status: VideoStatus;

  /**
   * Tamanho de cada parte em bytes (100 MiB).
   * @example 104857600
   */
  part_size: number;

  /**
   * Quantidade de partes a enviar: ceil(size / part_size).
   * @example 1
   */
  part_count: number;
}
