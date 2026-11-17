import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import type { VideoFailureReason, VideoMetadata } from './video-metadata.types';

/**
 * Leituras e transições guardadas do ciclo de vida do vídeo. Cada transição é um
 * único UPDATE condicional no status de origem, então um job duplicado ou atrasado
 * não regride o estado; o retorno diz se alguma linha mudou.
 */
@Injectable()
export class VideoLifecycleService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ public_id: publicId });
  }

  async findExpiredDrafts(cutoff: Date): Promise<Video[]> {
    return this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
      order: { created_at: 'ASC' },
    });
  }

  async markProcessing(id: string): Promise<boolean> {
    return this.transition(id, [VideoStatus.DRAFT], {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });
  }

  async markReady(id: string, metadata: VideoMetadata): Promise<boolean> {
    return this.transition(id, [VideoStatus.DRAFT, VideoStatus.PROCESSING], {
      status: VideoStatus.READY,
      ...metadata,
    });
  }

  async markFailed(
    id: string,
    reason: VideoFailureReason,
    fromStatuses: VideoStatus[],
  ): Promise<boolean> {
    return this.transition(id, fromStatuses, {
      status: VideoStatus.FAILED,
      failure_reason: reason,
    });
  }

  private async transition(
    id: string,
    fromStatuses: VideoStatus[],
    changes: Partial<Video>,
  ): Promise<boolean> {
    if (fromStatuses.length === 0) {
      return false;
    }
    const result = await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set(changes)
      .where('id = :id', { id })
      .andWhere('status IN (:...fromStatuses)', { fromStatuses })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
