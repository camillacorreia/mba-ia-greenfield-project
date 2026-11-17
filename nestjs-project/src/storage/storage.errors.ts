import { S3_ERROR_NAMES } from './storage.constants';

// Erros do storage em termos do domínio de upload, para que quem chama o
// StorageService decida o código HTTP sem conhecer os nomes de erro do SDK.
export class StorageNoSuchUploadError extends Error {
  constructor(options?: ErrorOptions) {
    super('Multipart upload does not exist', options);
    this.name = 'StorageNoSuchUploadError';
  }
}

export class StorageInvalidPartsError extends Error {
  constructor(options?: ErrorOptions) {
    super('Uploaded parts do not match the multipart upload', options);
    this.name = 'StorageInvalidPartsError';
  }
}

export function s3ErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export function isNoSuchUpload(error: unknown): boolean {
  return s3ErrorName(error) === S3_ERROR_NAMES.NO_SUCH_UPLOAD;
}

export function isInvalidParts(error: unknown): boolean {
  const name = s3ErrorName(error);
  return (
    name !== undefined &&
    (S3_ERROR_NAMES.INVALID_PARTS as readonly string[]).includes(name)
  );
}
