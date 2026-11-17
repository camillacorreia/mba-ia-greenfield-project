import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  /** @example 1 */
  @IsInt()
  @Min(1)
  part_number: number;

  /**
   * ETag devolvido pelo storage no PUT da parte.
   * @example "\"9b2cf535f27731c974343645a3985328\""
   */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Todas as partes enviadas, com o ETag de cada uma. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
