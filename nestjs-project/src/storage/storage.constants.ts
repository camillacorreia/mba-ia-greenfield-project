export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PUBLIC_SIGNER = Symbol('S3_PUBLIC_SIGNER');

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export const S3_ERROR_NAMES = {
  NO_SUCH_UPLOAD: 'NoSuchUpload',
  NOT_FOUND: 'NotFound',
  INVALID_PARTS: ['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'],
} as const;
