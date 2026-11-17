import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), ChannelsModule],
  providers: [VideoLifecycleService],
  exports: [VideoLifecycleService],
})
export class VideosModule {}
