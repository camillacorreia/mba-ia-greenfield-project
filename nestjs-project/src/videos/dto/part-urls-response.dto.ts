export class PartUrlDto {
  /** @example 1 */
  part_number: number;

  /** URL pré-assinada de UploadPart; o cliente faz PUT dos bytes da parte nela. */
  url: string;
}

export class PartUrlsResponseDto {
  /** URLs na ordem pedida. */
  parts: PartUrlDto[];

  /**
   * Validade das URLs em segundos.
   * @example 3600
   */
  expires_in: number;
}
