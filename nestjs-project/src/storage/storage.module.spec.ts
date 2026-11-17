import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_SIGNER } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile with storageConfig and provide both S3 clients and StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(S3_INTERNAL_CLIENT)).toBeDefined();
    expect(module.get(S3_PUBLIC_SIGNER)).not.toBe(
      module.get(S3_INTERNAL_CLIENT),
    );
    await module.close();
  });
});
