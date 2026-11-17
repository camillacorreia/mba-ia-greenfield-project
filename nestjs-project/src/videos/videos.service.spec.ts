import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UnsupportedVideoFormatException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
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
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue(CHANNEL);
    storageService.createVideoUpload.mockResolvedValue('upload-1');
    storageService.abortVideoUpload.mockResolvedValue(true);
    videoRepository.insert.mockResolvedValue({});
    videoRepository.findOneBy.mockResolvedValue(null);
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
