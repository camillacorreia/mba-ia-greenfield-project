import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ConfigType } from '@nestjs/config';
import queueConfig from './config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing/video-processing.constants';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM do `docker compose stop` fecha o Worker do BullMQ e as conexões.
  app.enableShutdownHooks();

  const queue = app.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  new Logger('VideoWorker').log(
    `Video worker ready, consuming "${VIDEO_PROCESSING_QUEUE}" with prefix "${queue.prefix}" on ${queue.redisHost}:${queue.redisPort}`,
  );
}
void bootstrap();
