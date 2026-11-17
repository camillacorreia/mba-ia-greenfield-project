import { IsInt, IsNotEmpty, IsString, Length, Min } from 'class-validator';

export class InitiateUploadDto {
  /** Nome original do arquivo, usado no download. */
  @IsString()
  @Length(1, 255)
  filename: string;

  /**
   * Tamanho declarado em bytes. Acima de 10 GiB responde 413 VIDEO_TOO_LARGE.
   * @example 5000000
   */
  @IsInt()
  @Min(1)
  size: number;

  /**
   * Tipo do arquivo. Fora de video/mp4 e video/webm responde 415 UNSUPPORTED_VIDEO_FORMAT.
   * @example "video/mp4"
   */
  @IsString()
  @IsNotEmpty()
  content_type: string;
}
