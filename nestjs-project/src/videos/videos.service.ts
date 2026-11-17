import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import {
  StorageInvalidPartsError,
  StorageNoSuchUploadError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import type { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId, isValidPublicId } from './public-id.util';
import { VideoLifecycleService } from './video-lifecycle.service';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  PART_URL_EXPIRES_IN_SECONDS,
  PUBLIC_ID_MAX_RETRIES,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly lifecycle: VideoLifecycleService,
    private readonly processingProducer: VideoProcessingProducer,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    if (dto.size > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    if (!isAllowedContentType(dto.content_type)) {
      throw new UnsupportedVideoFormatException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const uploadId = await this.storageService.createVideoUpload(
      id,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.insertDraft({
        id,
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: dto.size,
        upload_id: uploadId,
      });
    } catch (error) {
      // Compensação: sem a linha do rascunho, ninguém mais abortaria esse multipart.
      await this.abortQuietly(id, uploadId);
      throw error;
    }

    return {
      public_id: video.public_id,
      status: video.status,
      part_size: UPLOAD_PART_SIZE_BYTES,
      part_count: partCountFor(dto.size),
    };
  }

  /**
   * Owner check comum às rotas `/videos/:publicId`. `publicId` malformado,
   * inexistente ou de outro canal respondem igual, para não revelar que um
   * `public_id` existe.
   */
  async findOwnedVideo(userId: string, publicId: string): Promise<Video> {
    if (!isValidPublicId(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async requestPartUrls(
    userId: string,
    publicId: string,
    dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotDraftException();
    }
    const partCount = partCountFor(video.size_bytes);
    if (dto.part_numbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException();
    }

    const uploadId = video.upload_id;
    const parts = await Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.id,
          uploadId,
          partNumber,
          PART_URL_EXPIRES_IN_SECONDS,
        ),
      })),
    );
    return { parts, expires_in: PART_URL_EXPIRES_IN_SECONDS };
  }

  /**
   * Ordem fixa (TD-01): CompleteMultipartUpload → HeadObject com o tamanho
   * declarado → enqueue idempotente (`jobId = id`) → `draft → processing`. Se o
   * processo cair entre o enqueue e a transição, o retry do cliente reenfileira
   * sem duplicar e conclui a transição.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotDraftException();
    }

    const parts = [...dto.parts]
      .sort((a, b) => a.part_number - b.part_number)
      .map((part) => ({ partNumber: part.part_number, etag: part.etag }));
    try {
      await this.storageService.completeVideoUpload(
        video.id,
        video.upload_id,
        parts,
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartsError) {
        throw new InvalidUploadPartsException();
      }
      // NoSuchUpload: um complete anterior pode ter fechado o multipart antes de
      // a transição acontecer. Só segue se o objeto final existir (checado abaixo).
      if (!(error instanceof StorageNoSuchUploadError)) {
        throw error;
      }
    }

    const objectSize = await this.storageService.headVideo(video.id);
    if (objectSize === null) {
      throw new InvalidUploadPartsException();
    }
    if (objectSize !== video.size_bytes) {
      // O objeto original é mantido no bucket (TD-09).
      await this.lifecycle.markFailed(video.id, 'UPLOAD_SIZE_MISMATCH', [
        VideoStatus.DRAFT,
      ]);
      throw new UploadSizeMismatchException();
    }

    await this.processingProducer.enqueueProcessing(video.id);
    await this.lifecycle.markProcessing(video.id);

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  private async insertDraft(fields: Partial<Video>): Promise<Video> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_RETRIES; attempt++) {
      const draft = this.videoRepository.create({
        ...fields,
        public_id: generatePublicId(),
      });
      try {
        await this.videoRepository.insert(draft);
        return draft;
      } catch (error) {
        if (!isPgUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN)) {
          throw error;
        }
      }
    }
    throw new Error(
      'public_id conflict could not be resolved after max retries',
    );
  }

  private async abortQuietly(key: string, uploadId: string): Promise<void> {
    try {
      await this.storageService.abortVideoUpload(key, uploadId);
    } catch (abortError) {
      this.logger.error(
        `Failed to abort multipart upload ${uploadId} for ${key}`,
        abortError instanceof Error ? abortError.stack : String(abortError),
      );
    }
  }
}

function partCountFor(sizeBytes: number): number {
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

function isAllowedContentType(value: string): boolean {
  return (ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(value);
}
