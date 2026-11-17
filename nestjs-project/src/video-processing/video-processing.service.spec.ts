import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import {
  MediaInspector,
  MediaUnreadableError,
  type ProbeResult,
} from './media-inspector.service';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = 'video-1';
// Diferente do id de propósito: o worker lê o original pela coluna storage_key.
const STORAGE_KEY = 'stored/original-1';
const URL = 'http://minio:9000/videos/video-1?signed';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const MP4_PROBE: ProbeResult = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 120,
  video: { codec: 'h264', width: 1920, height: 1080 },
  audio: { codec: 'aac' },
};

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    storage_key: STORAGE_KEY,
    status: VideoStatus.PROCESSING,
    content_type: 'video/mp4',
    ...overrides,
  } as Video;
}

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const lifecycle = {
    findById: jest.fn(),
    markReady: jest.fn(),
    markFailed: jest.fn(),
  };
  const storage = { presignVideoGet: jest.fn(), putThumbnail: jest.fn() };
  const inspector = { probe: jest.fn(), extractFrame: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    lifecycle.findById.mockResolvedValue(video());
    lifecycle.markReady.mockResolvedValue(true);
    lifecycle.markFailed.mockResolvedValue(true);
    storage.presignVideoGet.mockResolvedValue(URL);
    storage.putThumbnail.mockResolvedValue(undefined);
    inspector.probe.mockResolvedValue(MP4_PROBE);
    inspector.extractFrame.mockResolvedValue(JPEG);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: StorageService, useValue: storage },
        { provide: MediaInspector, useValue: inspector },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  it.each([VideoStatus.READY, VideoStatus.FAILED])(
    'should be a no-op for a video already in %s',
    async (status) => {
      lifecycle.findById.mockResolvedValue(video({ status }));

      await service.process(VIDEO_ID);

      expect(storage.presignVideoGet).not.toHaveBeenCalled();
      expect(lifecycle.markReady).not.toHaveBeenCalled();
      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    },
  );

  it('should be a no-op for a video that no longer exists', async () => {
    lifecycle.findById.mockResolvedValue(null);

    await expect(service.process(VIDEO_ID)).resolves.toBeUndefined();
    expect(storage.presignVideoGet).not.toHaveBeenCalled();
  });

  it('should read the original through an internal signed URL of its storage_key, valid for 900s', async () => {
    await service.process(VIDEO_ID);

    expect(storage.presignVideoGet).toHaveBeenCalledWith(STORAGE_KEY, {
      signer: 'internal',
      expiresIn: 900,
    });
    expect(inspector.probe).toHaveBeenCalledWith(URL);
  });

  it('should store the thumbnail at {id}.jpg taken at the policy timestamp and mark ready', async () => {
    await service.process(VIDEO_ID);

    // 10% de 120s = 12s, limitado a 5s
    expect(inspector.extractFrame).toHaveBeenCalledWith(URL, 5);
    expect(storage.putThumbnail).toHaveBeenCalledWith('video-1.jpg', JPEG);
    expect(lifecycle.markReady).toHaveBeenCalledWith(VIDEO_ID, {
      duration_seconds: 120,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: 'video-1.jpg',
    });
  });

  it('should store a null audio codec for a video without audio', async () => {
    inspector.probe.mockResolvedValue({ ...MP4_PROBE, audio: null });

    await service.process(VIDEO_ID);

    expect(lifecycle.markReady).toHaveBeenCalledWith(
      VIDEO_ID,
      expect.objectContaining({ audio_codec: null }),
    );
  });

  it.each([
    [
      'UNSUPPORTED_CODEC',
      { ...MP4_PROBE, video: { codec: 'mpeg4', width: 320, height: 240 } },
    ],
    ['UNSUPPORTED_CONTAINER', { ...MP4_PROBE, formatName: 'matroska,webm' }],
    ['INVALID_MEDIA', { ...MP4_PROBE, video: null }],
    ['INVALID_MEDIA', { ...MP4_PROBE, durationSeconds: null }],
  ])(
    'should mark %s and throw UnrecoverableError without a thumbnail',
    async (reason, probe) => {
      inspector.probe.mockResolvedValue(probe);

      const error = await service.process(VIDEO_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe(reason);
      expect(lifecycle.markFailed).toHaveBeenCalledWith(VIDEO_ID, reason, [
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
      ]);
      expect(inspector.extractFrame).not.toHaveBeenCalled();
      expect(lifecycle.markReady).not.toHaveBeenCalled();
    },
  );

  it('should treat an unreadable file as INVALID_MEDIA', async () => {
    inspector.probe.mockRejectedValue(new MediaUnreadableError('bad file'));

    await expect(service.process(VIDEO_ID)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(lifecycle.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      'INVALID_MEDIA',
      [VideoStatus.DRAFT, VideoStatus.PROCESSING],
    );
  });

  it.each([
    ['probe', () => inspector.probe.mockRejectedValue(new Error('ECONNRESET'))],
    [
      'extractFrame',
      () =>
        inspector.extractFrame.mockRejectedValue(new Error('ffmpeg exit 1')),
    ],
    [
      'putThumbnail',
      () => storage.putThumbnail.mockRejectedValue(new Error('storage down')),
    ],
  ])(
    'should rethrow a transient error from %s without marking failed',
    async (_step, arrange) => {
      arrange();

      const error = await service.process(VIDEO_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(lifecycle.markFailed).not.toHaveBeenCalled();
      expect(lifecycle.markReady).not.toHaveBeenCalled();
    },
  );
});
