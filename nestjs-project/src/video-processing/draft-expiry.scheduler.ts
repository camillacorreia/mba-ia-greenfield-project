import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  EXPIRE_DRAFTS_JOB,
  EXPIRE_DRAFTS_SCHEDULER_ID,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

/** Varredura de rascunhos expirados a cada 1h. */
export const EXPIRE_DRAFTS_EVERY_MS = 60 * 60 * 1000;

/**
 * Registra o Job Scheduler da expiração no bootstrap do worker. O upsert é
 * idempotente pelo id do scheduler, então reinícios não duplicam o agendamento.
 */
@Injectable()
export class DraftExpiryScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXPIRE_DRAFTS_SCHEDULER_ID,
      { every: EXPIRE_DRAFTS_EVERY_MS },
      { name: EXPIRE_DRAFTS_JOB, data: {} },
    );
  }
}
