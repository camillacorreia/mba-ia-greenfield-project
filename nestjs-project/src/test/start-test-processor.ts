import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { bullRootOptions } from '../queue/bull-root.options';
import { User } from '../users/entities/user.entity';
import { VideoProcessingModule } from '../video-processing/video-processing.module';
import { Video } from '../videos/entities/video.entity';
import { createTestDataSource } from './create-test-data-source';

export interface TestProcessor {
  module: TestingModule;
  close: () => Promise<void>;
}

/**
 * Sobe o consumer da fila `video-processing` com o prefixo de teste
 * (`streamtube-test`, via setup-test-env). O video-worker do Compose escuta só o
 * prefixo de runtime, então só este processor consome os jobs das suítes (TD-10).
 */
export async function startTestProcessor(): Promise<TestProcessor> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(
        createTestDataSource(
          [User, Channel, RefreshToken, VerificationToken, Video],
          { synchronize: false },
        ).options,
      ),
      BullModule.forRootAsync({
        inject: [queueConfig.KEY],
        useFactory: bullRootOptions,
      }),
      VideoProcessingModule,
    ],
  }).compile();
  await module.init();
  return { module, close: () => module.close() };
}
