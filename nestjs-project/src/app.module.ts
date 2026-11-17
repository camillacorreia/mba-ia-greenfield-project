import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { configModuleOptions } from './config/config-module.options';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { bullRootOptions } from './queue/bull-root.options';
import { VideosModule } from './videos/videos.module';

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
    AuthModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
