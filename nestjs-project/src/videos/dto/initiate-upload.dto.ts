import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class InitiateUploadDto {
  /**
   * Título do vídeo, sem espaços nas pontas (1..100 caracteres). Quando ausente,
   * o rascunho usa o nome do arquivo sem a extensão. Editável na Fase 04.
   * @example "Aula 1: introdução"
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  title?: string;

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
