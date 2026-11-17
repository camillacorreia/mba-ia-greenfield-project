import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from './config/config-module.options';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { bullRootOptions } from './queue/bull-root.options';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

/**
 * Raiz do processo `video-worker` (TD-04): mesma config, banco e fila da API,
 * mas só com o consumer da fila `video-processing`, sem servidor HTTP.
 */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: buildTypeOrmOptions,
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: bullRootOptions,
    }),
    // `autoLoadEntities` só registra entidades de módulos importados. `Channel`
    // tem relação com `User`, então sem o UsersModule a metadata do TypeORM não
    // fecha e o worker fica tentando reconectar ao banco.
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
