import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_SIGNER } from './storage.constants';
import { StorageService } from './storage.service';

function baseClientConfig(config: ConfigType<typeof storageConfig>) {
  return {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
}

@Module({
  providers: [
    {
      // Chamadas server-side e URLs consumidas dentro da rede do Compose.
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          ...baseClientConfig(config),
          endpoint: config.endpoint,
        }),
    },
    {
      // Só assina URLs entregues a clientes fora da rede. O host entra na assinatura,
      // então não dá para reescrever a URL depois. Sem checksum fixado na URL de
      // UploadPart, porque o corpo não é conhecido na hora de assinar.
      provide: S3_PUBLIC_SIGNER,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          ...baseClientConfig(config),
          endpoint: config.publicEndpoint,
          requestChecksumCalculation: 'WHEN_REQUIRED',
        }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
