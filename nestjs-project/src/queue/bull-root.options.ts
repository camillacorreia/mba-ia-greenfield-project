import type { ConfigType } from '@nestjs/config';
import type { QueueOptions } from 'bullmq';
import queueConfig from '../config/queue.config';

// Compartilhado pela API e pelo worker: mesma conexão e mesmo prefixo. Nos testes o
// prefixo é `streamtube-test`, então o video-worker (prefixo de runtime) não consome
// jobs criados pelas suítes.
export function bullRootOptions(
  config: ConfigType<typeof queueConfig>,
): QueueOptions {
  return {
    connection: { host: config.redisHost, port: config.redisPort },
    prefix: config.prefix,
  };
}
