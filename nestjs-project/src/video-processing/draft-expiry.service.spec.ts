import { Test } from '@nestjs/testing';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { DraftExpiryService } from './draft-expiry.service';

const NOW = new Date('2026-11-17T12:00:00Z');

function draft(id: string, uploadId: string | null = `upload-${id}`): Video {
  return {
    id,
    // Diferente do id de propósito: o abort usa a chave persistida.
    storage_key: `stored/${id}`,
    status: VideoStatus.DRAFT,
    upload_id: uploadId,
  } as Video;
}

describe('DraftExpiryService', () => {
  let service: DraftExpiryService;
  const lifecycle = { findExpiredDrafts: jest.fn(), markFailed: jest.fn() };
  const storage = { abortVideoUpload: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    lifecycle.findExpiredDrafts.mockResolvedValue([]);
    lifecycle.markFailed.mockResolvedValue(true);
    storage.abortVideoUpload.mockResolvedValue(true);

    const module = await Test.createTestingModule({
      providers: [
        DraftExpiryService,
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = module.get(DraftExpiryService);
  });

  it('should look for drafts created more than 24h before now', async () => {
    await service.expireDrafts(NOW);

    expect(lifecycle.findExpiredDrafts).toHaveBeenCalledWith(
      new Date('2026-11-16T12:00:00Z'),
    );
  });

  it('should abort the multipart and mark UPLOAD_EXPIRED only from draft', async () => {
    lifecycle.findExpiredDrafts.mockResolvedValue([draft('a')]);

    await expect(service.expireDrafts(NOW)).resolves.toBe(1);
    expect(storage.abortVideoUpload).toHaveBeenCalledWith(
      'stored/a',
      'upload-a',
    );
    expect(lifecycle.markFailed).toHaveBeenCalledWith('a', 'UPLOAD_EXPIRED', [
      VideoStatus.DRAFT,
    ]);
  });

  it('should still expire a draft whose multipart was already aborted by the storage', async () => {
    lifecycle.findExpiredDrafts.mockResolvedValue([draft('a')]);
    storage.abortVideoUpload.mockResolvedValue(false);

    await expect(service.expireDrafts(NOW)).resolves.toBe(1);
    expect(lifecycle.markFailed).toHaveBeenCalledTimes(1);
  });

  it('should expire a draft without upload_id without calling the storage', async () => {
    lifecycle.findExpiredDrafts.mockResolvedValue([draft('a', null)]);

    await expect(service.expireDrafts(NOW)).resolves.toBe(1);
    expect(storage.abortVideoUpload).not.toHaveBeenCalled();
  });

  it('should keep going when one item fails and count only the expired ones', async () => {
    lifecycle.findExpiredDrafts.mockResolvedValue([
      draft('a'),
      draft('b'),
      draft('c'),
    ]);
    storage.abortVideoUpload.mockImplementation((key: string) =>
      key === 'stored/b'
        ? Promise.reject(new Error('storage down'))
        : Promise.resolve(true),
    );

    await expect(service.expireDrafts(NOW)).resolves.toBe(2);
    expect(lifecycle.markFailed).toHaveBeenCalledTimes(2);
    expect(lifecycle.markFailed).not.toHaveBeenCalledWith(
      'b',
      expect.anything(),
      expect.anything(),
    );
  });

  it('should not count a draft that changed status meanwhile', async () => {
    lifecycle.findExpiredDrafts.mockResolvedValue([draft('a')]);
    lifecycle.markFailed.mockResolvedValue(false);

    await expect(service.expireDrafts(NOW)).resolves.toBe(0);
  });
});
