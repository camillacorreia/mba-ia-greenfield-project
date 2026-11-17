import { randomBytes, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageNoSuchUploadError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService, type UploadedPart } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const PART_URL_TTL = 3600;

async function compileStorageModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let internalClient: S3Client;
  const createdVideoKeys: string[] = [];
  const createdThumbnailKeys: string[] = [];

  beforeAll(async () => {
    module = await compileStorageModule();
    storage = module.get(StorageService);
    internalClient = module.get(S3_INTERNAL_CLIENT);
  });

  afterAll(async () => {
    const buckets = [
      ...createdVideoKeys.map((Key) => ({ Bucket: 'videos-test', Key })),
      ...createdThumbnailKeys.map((Key) => ({
        Bucket: 'thumbnails-test',
        Key,
      })),
    ];
    for (const target of buckets) {
      await internalClient.send(new DeleteObjectCommand(target));
    }
    await module.close();
  });

  function newVideoKey(): string {
    const key = randomUUID();
    createdVideoKeys.push(key);
    return key;
  }

  async function putPart(url: string, body: Buffer): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  }

  async function uploadParts(
    key: string,
    uploadId: string,
    bodies: Buffer[],
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    for (const [index, body] of bodies.entries()) {
      const partNumber = index + 1;
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        partNumber,
        PART_URL_TTL,
      );
      const response = await putPart(url, body);
      parts.push({ partNumber, etag: response.headers.get('etag') ?? '' });
    }
    return parts;
  }

  describe('multipart upload', () => {
    it('should accept a PUT of bytes on a signed UploadPart URL and return an ETag', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createVideoUpload(key, 'video/mp4');
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        PART_URL_TTL,
      );

      const response = await putPart(url, randomBytes(1024));

      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBeTruthy();
      await storage.abortVideoUpload(key, uploadId);
    });

    it('should complete the upload into an object whose size matches the bytes sent', async () => {
      const key = newVideoKey();
      const bodies = [randomBytes(MIN_PART_SIZE), randomBytes(1234)];
      const uploadId = await storage.createVideoUpload(key, 'video/mp4');
      const parts = await uploadParts(key, uploadId, bodies);

      await storage.completeVideoUpload(key, uploadId, parts);

      expect(await storage.headVideo(key)).toBe(MIN_PART_SIZE + 1234);
    });

    it('should translate a part rejected by the storage into StorageInvalidPartsError', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createVideoUpload(key, 'video/mp4');
      await uploadParts(key, uploadId, [randomBytes(1024)]);

      await expect(
        storage.completeVideoUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(StorageInvalidPartsError);
      await storage.abortVideoUpload(key, uploadId);
    });

    it('should translate completing an aborted upload into StorageNoSuchUploadError', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createVideoUpload(key, 'video/mp4');
      const parts = await uploadParts(key, uploadId, [randomBytes(1024)]);
      await storage.abortVideoUpload(key, uploadId);

      await expect(
        storage.completeVideoUpload(key, uploadId, parts),
      ).rejects.toBeInstanceOf(StorageNoSuchUploadError);
    });

    it('should abort once and return false when aborting again', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createVideoUpload(key, 'video/webm');

      await expect(storage.abortVideoUpload(key, uploadId)).resolves.toBe(true);
      await expect(storage.abortVideoUpload(key, uploadId)).resolves.toBe(
        false,
      );
    });

    it('should return null from headVideo when the object does not exist', async () => {
      await expect(storage.headVideo(randomUUID())).resolves.toBeNull();
    });
  });

  describe('reads', () => {
    it('should serve a byte range from a signed GetObject URL', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createVideoUpload(key, 'video/mp4');
      const parts = await uploadParts(key, uploadId, [randomBytes(4096)]);
      await storage.completeVideoUpload(key, uploadId, parts);
      const url = await storage.presignVideoGet(key, {
        signer: 'internal',
        expiresIn: 60,
      });

      const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(100);
    });

    it('should apply the response overrides on a signed GetObject URL', async () => {
      const key = newVideoKey();
      const uploadId = await storage.createVideoUpload(key, 'video/mp4');
      const parts = await uploadParts(key, uploadId, [randomBytes(256)]);
      await storage.completeVideoUpload(key, uploadId, parts);
      const url = await storage.presignVideoGet(key, {
        signer: 'public',
        expiresIn: 60,
        responseContentType: 'video/mp4',
        responseContentDisposition: 'attachment; filename="holiday.mp4"',
      });

      const response = await fetch(url);
      await response.arrayBuffer();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="holiday.mp4"',
      );
    });

    it('should store a thumbnail readable anonymously at its public URL', async () => {
      const key = `${randomUUID()}.jpg`;
      createdThumbnailKeys.push(key);

      await storage.putThumbnail(key, randomBytes(512));
      const response = await fetch(storage.thumbnailPublicUrl(key));
      await response.arrayBuffer();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
    });
  });

  describe('signers', () => {
    const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    let signerModule: TestingModule;
    let signerStorage: StorageService;

    beforeAll(async () => {
      // Nos testes os dois endpoints são iguais; aqui o público aponta para outro
      // host para provar qual cliente assina cada URL. Nenhuma requisição é feita.
      process.env.S3_PUBLIC_ENDPOINT = 'http://localhost:9000';
      signerModule = await compileStorageModule();
      signerStorage = signerModule.get(StorageService);
    });

    afterAll(async () => {
      process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
      await signerModule.close();
    });

    it('should sign UploadPart URLs with the S3_PUBLIC_ENDPOINT host', async () => {
      const url = await signerStorage.presignUploadPart('key', 'upload', 1, 60);

      expect(new URL(url).host).toBe('localhost:9000');
    });

    it('should sign GetObject URLs with the host of the chosen signer', async () => {
      const publicUrl = await signerStorage.presignVideoGet('key', {
        signer: 'public',
        expiresIn: 60,
      });
      const internalUrl = await signerStorage.presignVideoGet('key', {
        signer: 'internal',
        expiresIn: 60,
      });

      expect(new URL(publicUrl).host).toBe('localhost:9000');
      expect(new URL(internalUrl).host).toBe(
        new URL(process.env.S3_ENDPOINT ?? '').host,
      );
    });

    it('should not bake a checksum into signed UploadPart URLs', async () => {
      const url = await signerStorage.presignUploadPart('key', 'upload', 1, 60);

      expect(new URL(url).searchParams.toString()).not.toMatch(/checksum/i);
    });

    it('should build thumbnail URLs on S3_PUBLIC_ENDPOINT', () => {
      expect(signerStorage.thumbnailPublicUrl('abc.jpg')).toBe(
        'http://localhost:9000/thumbnails-test/abc.jpg',
      );
    });
  });
});
