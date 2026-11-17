import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';

/** Rascunho abandonado expira 1 dia depois de criado (TD-09, revisão de 2026-11-17). */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DraftExpiryService {
  private readonly logger = new Logger(DraftExpiryService.name);

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Aborta o multipart e marca `failed` com UPLOAD_EXPIRED cada rascunho criado
   * antes de `now - 24h`. Idempotente: a transição só vale a partir de `draft`.
   * Um item com erro é logado e não interrompe os outros.
   * @returns quantos vídeos expiraram nesta execução
   */
  async expireDrafts(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - DRAFT_TTL_MS);
    const drafts = await this.lifecycle.findExpiredDrafts(cutoff);

    let expired = 0;
    for (const draft of drafts) {
      try {
        if (draft.upload_id) {
          // `false` quando o storage já abortou (regra de stale uploads): não é erro.
          await this.storage.abortVideoUpload(
            draft.storage_key,
            draft.upload_id,
          );
        }
        const changed = await this.lifecycle.markFailed(
          draft.id,
          'UPLOAD_EXPIRED',
          [VideoStatus.DRAFT],
        );
        if (changed) expired++;
      } catch (error) {
        this.logger.error(
          `Failed to expire draft ${draft.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return expired;
  }
}
