import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class RequestPartUrlsDto {
  /**
   * Números das partes a assinar (1..10000 itens, sem repetição). Acima do
   * part_count do vídeo responde 400 INVALID_PART_NUMBER.
   * @example [1, 2, 3]
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
