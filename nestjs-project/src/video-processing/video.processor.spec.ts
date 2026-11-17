import { Test } from '@nestjs/testing';
import { type Job, UnrecoverableError } from 'bullmq';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { DraftExpiryService } from './draft-expiry.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: 'process-video',
    data: { videoId: 'video-1' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const processing = { process: jest.fn() };
  const lifecycle = { markFailed: jest.fn() };
  const draftExpiry = { expireDrafts: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    processing.process.mockResolvedValue(undefined);
    lifecycle.markFailed.mockResolvedValue(true);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: processing },
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: DraftExpiryService, useValue: draftExpiry },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should dispatch process-video to VideoProcessingService', async () => {
      await processor.process(job());

      expect(processing.process).toHaveBeenCalledWith('video-1');
    });

    it('should dispatch expire-drafts to DraftExpiryService', async () => {
      draftExpiry.expireDrafts.mockResolvedValue(2);

      await processor.process(job({ name: 'expire-drafts', data: {} }));

      expect(draftExpiry.expireDrafts).toHaveBeenCalledTimes(1);
      expect(processing.process).not.toHaveBeenCalled();
    });

    it('should reject an unknown job name as unrecoverable', async () => {
      await expect(
        processor.process(job({ name: 'unknown-job' })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(processing.process).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should mark PROCESSING_FAILED on the last attempt of a transient error', async () => {
      await processor.onFailed(
        job({ attemptsMade: 3 }),
        new Error('ECONNRESET'),
      );

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        'video-1',
        'PROCESSING_FAILED',
        [VideoStatus.DRAFT, VideoStatus.PROCESSING],
      );
    });

    it.each([1, 2])(
      'should not mark failed after attempt %s of 3',
      async (attemptsMade) => {
        await processor.onFailed(
          job({ attemptsMade }),
          new Error('ECONNRESET'),
        );

        expect(lifecycle.markFailed).not.toHaveBeenCalled();
      },
    );

    it('should ignore a permanent error, already handled by the job', async () => {
      await processor.onFailed(
        job({ attemptsMade: 3 }),
        new UnrecoverableError('UNSUPPORTED_CODEC'),
      );

      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });

    it('should ignore other job names and missing jobs', async () => {
      await processor.onFailed(
        job({ name: 'expire-drafts', attemptsMade: 3 }),
        new Error('boom'),
      );
      await processor.onFailed(undefined, new Error('boom'));

      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });
  });
});
