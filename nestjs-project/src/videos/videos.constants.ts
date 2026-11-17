/** 10 GiB (TD-02). */
export const MAX_VIDEO_SIZE_BYTES = 10737418240;

/** Tamanho fixo de cada parte do multipart: 100 MiB (TD-02). */
export const UPLOAD_PART_SIZE_BYTES = 104857600;

/** Allowlist de formatos aceitos no upload (TD-08). */
export const ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm'] as const;

export type AllowedVideoContentType =
  (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];

export const PUBLIC_ID_MAX_RETRIES = 5;
