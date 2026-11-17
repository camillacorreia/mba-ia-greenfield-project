import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  S3_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_SIGNER,
  THUMBNAIL_CONTENT_TYPE,
} from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageNoSuchUploadError,
  isInvalidParts,
  isNoSuchUpload,
  s3ErrorName,
} from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface PresignVideoGetOptions {
  signer: 'public' | 'internal';
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_SIGNER) private readonly publicSigner: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicSigner.destroy();
  }

  async createVideoUpload(key: string, contentType: string): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicSigner,
      new UploadPartCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeVideoUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) {
        throw new StorageNoSuchUploadError({ cause: error });
      }
      if (isInvalidParts(error)) {
        throw new StorageInvalidPartsError({ cause: error });
      }
      throw error;
    }
  }

  /**
   * Devolve `false` quando o multipart já não existe (abortado, concluído ou
   * limpo pelo storage). O MinIO responde 204 ao abortar um UploadId inexistente,
   * então a existência é conferida antes com ListParts, que acusa NoSuchUpload.
   */
  async abortVideoUpload(key: string, uploadId: string): Promise<boolean> {
    const target = {
      Bucket: this.config.bucketVideos,
      Key: key,
      UploadId: uploadId,
    };
    try {
      await this.internalClient.send(
        new ListPartsCommand({ ...target, MaxParts: 1 }),
      );
      await this.internalClient.send(new AbortMultipartUploadCommand(target));
      return true;
    } catch (error) {
      if (isNoSuchUpload(error)) {
        return false;
      }
      throw error;
    }
  }

  /** Tamanho do objeto em bytes, ou `null` quando ele não existe. */
  async headVideo(key: string): Promise<number | null> {
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucketVideos, Key: key }),
      );
      return result.ContentLength ?? null;
    } catch (error) {
      if (s3ErrorName(error) === S3_ERROR_NAMES.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  async presignVideoGet(
    key: string,
    options: PresignVideoGetOptions,
  ): Promise<string> {
    const client =
      options.signer === 'public' ? this.publicSigner : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
        ResponseContentType: options.responseContentType,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  async putThumbnail(key: string, body: Buffer): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucketThumbnails,
        Key: key,
        Body: body,
        ContentType: THUMBNAIL_CONTENT_TYPE,
      }),
    );
  }

  thumbnailPublicUrl(key: string): string {
    const base = this.config.publicEndpoint.replace(/\/+$/, '');
    return `${base}/${this.config.bucketThumbnails}/${key}`;
  }
}
