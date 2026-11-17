import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  UnsupportedVideoFormatException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
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
      part_count: Math.ceil(dto.size / UPLOAD_PART_SIZE_BYTES),
    };
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

function isAllowedContentType(value: string): boolean {
  return (ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(value);
}
