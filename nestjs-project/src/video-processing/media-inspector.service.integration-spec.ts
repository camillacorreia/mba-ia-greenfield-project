import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { checkPlayability } from './codec-policy';
import {
  MediaInspector,
  MediaUnreadableError,
} from './media-inspector.service';

const FIXTURES_DIR = join(__dirname, '../../test/fixtures/media');

describe('MediaInspector (integration)', () => {
  let module: TestingModule;
  let inspector: MediaInspector;
  let storage: StorageService;
  let s3: S3Client;
  const keys = new Map<string, string>();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaInspector],
    }).compile();
    inspector = module.get(MediaInspector);
    storage = module.get(StorageService);
    s3 = module.get(S3_INTERNAL_CLIENT);

    for (const fixture of [
      'sample-h264-aac.mp4',
      'sample-vp9-opus.webm',
      'sample-mpeg4.mp4',
      'not-a-video.mp4',
    ]) {
      const key = randomUUID();
      await s3.send(
        new PutObjectCommand({
          Bucket: 'videos-test',
          Key: key,
          Body: readFileSync(join(FIXTURES_DIR, fixture)),
        }),
      );
      keys.set(fixture, key);
    }
  });

  afterAll(async () => {
    for (const key of keys.values()) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: 'videos-test', Key: key }),
      );
    }
    await module.close();
  });

  async function internalUrl(fixture: string): Promise<string> {
    return storage.presignVideoGet(keys.get(fixture) ?? '', {
      signer: 'internal',
      expiresIn: 300,
    });
  }

  it('should probe the h264/aac MP4 through a signed internal URL', async () => {
    const result = await inspector.probe(
      await internalUrl('sample-h264-aac.mp4'),
    );

    expect(result.formatName.split(',')).toContain('mp4');
    expect(result.video).toEqual({ codec: 'h264', width: 320, height: 240 });
    expect(result.audio).toEqual({ codec: 'aac' });
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('should probe the vp9/opus WebM', async () => {
    const result = await inspector.probe(
      await internalUrl('sample-vp9-opus.webm'),
    );

    expect(result.formatName.split(',')).toContain('webm');
    expect(result.video?.codec).toBe('vp9');
    expect(result.audio).toEqual({ codec: 'opus' });
  });

  it('should extract a JPEG frame from the MP4', async () => {
    const frame = await inspector.extractFrame(
      await internalUrl('sample-h264-aac.mp4'),
      0.15,
    );

    expect([...frame.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('should extract a JPEG frame from the WebM', async () => {
    const frame = await inspector.extractFrame(
      await internalUrl('sample-vp9-opus.webm'),
      0.15,
    );

    expect([...frame.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('should throw MediaUnreadableError for a file that is not a video', async () => {
    await expect(
      inspector.probe(await internalUrl('not-a-video.mp4')),
    ).rejects.toBeInstanceOf(MediaUnreadableError);
  });

  describe('with the codec policy', () => {
    it('should flag the MPEG-4 Part 2 MP4 as UNSUPPORTED_CODEC', async () => {
      const result = await inspector.probe(
        await internalUrl('sample-mpeg4.mp4'),
      );

      expect(checkPlayability('video/mp4', result)).toBe('UNSUPPORTED_CODEC');
    });

    it('should accept the vp9/opus WebM declared as video/webm', async () => {
      const result = await inspector.probe(
        await internalUrl('sample-vp9-opus.webm'),
      );

      expect(checkPlayability('video/webm', result)).toBe('ok');
    });

    it('should flag the MP4 declared as video/webm as UNSUPPORTED_CONTAINER', async () => {
      const result = await inspector.probe(
        await internalUrl('sample-h264-aac.mp4'),
      );

      expect(checkPlayability('video/webm', result)).toBe(
        'UNSUPPORTED_CONTAINER',
      );
    });
  });
});
