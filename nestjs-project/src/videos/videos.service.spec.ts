import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import {
  StorageInvalidPartsError,
  StorageNoSuchUploadError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { VideoLifecycleService } from './video-lifecycle.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };

function uniqueViolation(column: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, {
    code: '23505',
    detail: `Key (${column})=(abc) already exists.`,
  });
  return error;
}

function dto(overrides: Partial<InitiateUploadDto> = {}): InitiateUploadDto {
  return {
    filename: 'aula.mp4',
    size: 5000000,
    content_type: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((fields: Partial<Video>) => ({ ...fields }) as Video),
    insert: jest.fn<Promise<unknown>, [Video]>(),
    findOneBy: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createVideoUpload: jest.fn(),
    abortVideoUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    completeVideoUpload: jest.fn(),
    headVideo: jest.fn(),
    presignVideoGet: jest.fn(),
  };
  const lifecycle = { markProcessing: jest.fn(), markFailed: jest.fn() };
  const processingProducer = { enqueueProcessing: jest.fn() };
  const callOrder: string[] = [];

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue(CHANNEL);
    storageService.createVideoUpload.mockResolvedValue('upload-1');
    storageService.abortVideoUpload.mockResolvedValue(true);
    videoRepository.insert.mockResolvedValue({});
    videoRepository.findOneBy.mockResolvedValue(null);
    callOrder.length = 0;
    storageService.completeVideoUpload.mockResolvedValue(undefined);
    storageService.headVideo.mockResolvedValue(5000000);
    lifecycle.markFailed.mockResolvedValue(true);
    lifecycle.markProcessing.mockImplementation(() => {
      callOrder.push('markProcessing');
      return Promise.resolve(true);
    });
    processingProducer.enqueueProcessing.mockImplementation(() => {
      callOrder.push('enqueueProcessing');
      return Promise.resolve();
    });
    storageService.presignUploadPart.mockImplementation(
      (key: string, uploadId: string, partNumber: number) =>
        Promise.resolve(
          `http://storage/${key}?uploadId=${uploadId}&part=${partNumber}`,
        ),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: VideoProcessingProducer, useValue: processingProducer },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('should reject a size above 10 GiB before touching channel or storage', async () => {
      await expect(
        service.initiateUpload(USER_ID, dto({ size: 10737418241 })),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(channelsService.findByUserId).not.toHaveBeenCalled();
      expect(storageService.createVideoUpload).not.toHaveBeenCalled();
    });

    it('should reject a content type outside the allowlist', async () => {
      await expect(
        service.initiateUpload(
          USER_ID,
          dto({ content_type: 'video/quicktime' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
      expect(storageService.createVideoUpload).not.toHaveBeenCalled();
    });

    it('should accept video/webm', async () => {
      await expect(
        service.initiateUpload(USER_ID, dto({ content_type: 'video/webm' })),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
    });

    it('should throw ChannelNotFoundException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload(USER_ID, dto()),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(storageService.createVideoUpload).not.toHaveBeenCalled();
    });

    it('should open the multipart under the video id and store the draft with it', async () => {
      await service.initiateUpload(USER_ID, dto());

      const [key, contentType] = storageService.createVideoUpload.mock
        .calls[0] as [string, string];
      const inserted = videoRepository.insert.mock.calls[0][0];
      expect(contentType).toBe('video/mp4');
      expect(inserted).toMatchObject({
        id: key,
        channel_id: CHANNEL.id,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        original_filename: 'aula.mp4',
        size_bytes: 5000000,
      });
    });

    it('should retry with a new public_id on a public_id unique violation', async () => {
      videoRepository.insert
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockResolvedValueOnce({});

      const result = await service.initiateUpload(USER_ID, dto());

      const first = videoRepository.insert.mock.calls[0][0];
      const second = videoRepository.insert.mock.calls[1][0];
      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      expect(second.public_id).not.toBe(first.public_id);
      expect(result.public_id).toBe(second.public_id);
      expect(storageService.abortVideoUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart when public_id retries are exhausted', async () => {
      videoRepository.insert.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toThrow(
        /max retries/,
      );
      expect(videoRepository.insert).toHaveBeenCalledTimes(5);
      const [key] = storageService.createVideoUpload.mock.calls[0] as [string];
      expect(storageService.abortVideoUpload).toHaveBeenCalledWith(
        key,
        'upload-1',
      );
    });

    it('should abort the multipart and rethrow when the insert fails for another reason', async () => {
      const dbError = new Error('connection lost');
      videoRepository.insert.mockRejectedValue(dbError);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        dbError,
      );
      expect(videoRepository.insert).toHaveBeenCalledTimes(1);
      expect(storageService.abortVideoUpload).toHaveBeenCalledTimes(1);
    });

    it('should keep the original error when the compensating abort also fails', async () => {
      const dbError = new Error('connection lost');
      videoRepository.insert.mockRejectedValue(dbError);
      storageService.abortVideoUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        dbError,
      );
    });

    it.each([
      ['an exact multiple of the part size', 104857600 * 3, 3],
      ['a remainder', 104857600 * 3 + 1, 4],
      ['the 10 GiB maximum', 10737418240, 103],
      ['a single byte', 1, 1],
    ])('should compute part_count for %s', async (_label, size, expected) => {
      const result = await service.initiateUpload(USER_ID, dto({ size }));

      expect(result.part_size).toBe(104857600);
      expect(result.part_count).toBe(expected);
    });
  });

  describe('findOwnedVideo', () => {
    const PUBLIC_ID = 'AbCdEfGhIj_';

    it('should reject a malformed publicId without querying the database', async () => {
      await expect(
        service.findOwnedVideo(USER_ID, 'abc'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOneBy).not.toHaveBeenCalled();
    });

    it('should reject a publicId that does not exist', async () => {
      await expect(
        service.findOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject a video from another channel as not found', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ channel_id: 'other-channel' }),
      );

      await expect(
        service.findOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject when the user has no channel', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.findOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should return the video owned by the user channel', async () => {
      const video = draftVideo();
      videoRepository.findOneBy.mockResolvedValue(video);

      await expect(service.findOwnedVideo(USER_ID, PUBLIC_ID)).resolves.toBe(
        video,
      );
    });
  });

  describe('requestPartUrls', () => {
    const PUBLIC_ID = 'AbCdEfGhIj_';

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a video in %s with VideoNotDraftException',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(draftVideo({ status }));

        await expect(
          service.requestPartUrls(USER_ID, PUBLIC_ID, { part_numbers: [1] }),
        ).rejects.toBeInstanceOf(VideoNotDraftException);
        expect(storageService.presignUploadPart).not.toHaveBeenCalled();
      },
    );

    it('should reject a part number above the part count', async () => {
      // 250 MiB -> 3 partes de 100 MiB
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ size_bytes: 250 * 1024 * 1024 }),
      );

      await expect(
        service.requestPartUrls(USER_ID, PUBLIC_ID, { part_numbers: [1, 4] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should sign every part for 1 hour and return them in the requested order', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ size_bytes: 250 * 1024 * 1024 }),
      );

      const result = await service.requestPartUrls(USER_ID, PUBLIC_ID, {
        part_numbers: [3, 1, 2],
      });

      expect(result.expires_in).toBe(3600);
      expect(result.parts.map((part) => part.part_number)).toEqual([3, 1, 2]);
      expect(result.parts[0].url).toBe(
        'http://storage/video-1?uploadId=upload-1&part=3',
      );
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'video-1',
        'upload-1',
        3,
        3600,
      );
    });
  });

  describe('completeUpload', () => {
    const PUBLIC_ID = 'AbCdEfGhIj_';
    const PARTS = [
      { part_number: 2, etag: '"etag-2"' },
      { part_number: 1, etag: '"etag-1"' },
    ];

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
    });

    it('should complete with the parts sorted, enqueue and only then mark processing', async () => {
      const result = await service.completeUpload(USER_ID, PUBLIC_ID, {
        parts: PARTS,
      });

      expect(storageService.completeVideoUpload).toHaveBeenCalledWith(
        'video-1',
        'upload-1',
        [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      );
      expect(processingProducer.enqueueProcessing).toHaveBeenCalledWith(
        'video-1',
      );
      expect(callOrder).toEqual(['enqueueProcessing', 'markProcessing']);
      expect(result).toEqual({
        public_id: PUBLIC_ID,
        status: VideoStatus.PROCESSING,
      });
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a video in %s without touching storage or queue',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(draftVideo({ status }));

        await expect(
          service.completeUpload(USER_ID, PUBLIC_ID, { parts: PARTS }),
        ).rejects.toBeInstanceOf(VideoNotDraftException);
        expect(storageService.completeVideoUpload).not.toHaveBeenCalled();
        expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
      },
    );

    it('should map parts rejected by the storage to InvalidUploadPartsException and keep the draft', async () => {
      storageService.completeVideoUpload.mockRejectedValue(
        new StorageInvalidPartsError(),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: PARTS }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(lifecycle.markFailed).not.toHaveBeenCalled();
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should treat NoSuchUpload with the final object present as a retry and enqueue', async () => {
      storageService.completeVideoUpload.mockRejectedValue(
        new StorageNoSuchUploadError(),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: PARTS }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
      expect(callOrder).toEqual(['enqueueProcessing', 'markProcessing']);
    });

    it('should map NoSuchUpload without the final object to InvalidUploadPartsException', async () => {
      storageService.completeVideoUpload.mockRejectedValue(
        new StorageNoSuchUploadError(),
      );
      storageService.headVideo.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: PARTS }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should rethrow unexpected storage errors', async () => {
      const storageDown = new Error('storage down');
      storageService.completeVideoUpload.mockRejectedValue(storageDown);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: PARTS }),
      ).rejects.toBe(storageDown);
      expect(storageService.headVideo).not.toHaveBeenCalled();
    });

    it('should mark the video failed and throw on a size mismatch, without enqueueing', async () => {
      storageService.headVideo.mockResolvedValue(4999999);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: PARTS }),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        'video-1',
        'UPLOAD_SIZE_MISMATCH',
        [VideoStatus.DRAFT],
      );
      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
    });
  });

  describe('getStreamUrl', () => {
    const PUBLIC_ID = 'AbCdEfGhIj_';

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should reject a video in %s with VideoNotReadyException',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(draftVideo({ status }));

        await expect(
          service.getStreamUrl(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        expect(storageService.presignVideoGet).not.toHaveBeenCalled();
      },
    );

    it('should sign a ready video with the public signer for 1 hour and its content type', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({
          status: VideoStatus.READY,
          upload_id: null,
          content_type: 'video/webm',
        }),
      );
      storageService.presignVideoGet.mockResolvedValue('http://signed');

      await expect(service.getStreamUrl(USER_ID, PUBLIC_ID)).resolves.toBe(
        'http://signed',
      );
      expect(storageService.presignVideoGet).toHaveBeenCalledWith('video-1', {
        signer: 'public',
        expiresIn: 3600,
        responseContentType: 'video/webm',
      });
    });

    it('should apply the owner check before the status check', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, channel_id: 'other' }),
      );

      await expect(
        service.getStreamUrl(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      public_id: 'AbCdEfGhIj_',
      channel_id: CHANNEL.id,
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      size_bytes: 5000000,
      ...overrides,
    } as Video;
  }
});
