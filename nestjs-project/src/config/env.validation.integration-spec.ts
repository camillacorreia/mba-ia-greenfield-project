import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
  S3_BUCKET_VIDEOS: 'videos',
  S3_BUCKET_THUMBNAILS: 'thumbnails',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

const validateWithout = (key: keyof typeof requiredEnv) => {
  const env: Record<string, string> = { ...requiredEnv };
  delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveProperty('SWAGGER_ENABLED', 'false');
  });
});

describe('envValidationSchema — storage', () => {
  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET_VIDEOS',
    'S3_BUCKET_THUMBNAILS',
  ] as const)('should reject a missing %s', (key) => {
    const { error } = validateWithout(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject an S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'minio' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject S3_FORCE_PATH_STYLE with an invalid value', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'yes' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_FORCE_PATH_STYLE');
  });

  it('should apply defaults for S3_REGION and S3_FORCE_PATH_STYLE', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveProperty('S3_REGION', 'us-east-1');
    expect(result.value).toHaveProperty('S3_FORCE_PATH_STYLE', 'false');
  });
});

describe('envValidationSchema — queue', () => {
  it('should apply defaults for REDIS_HOST, REDIS_PORT and QUEUE_PREFIX', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveProperty('REDIS_HOST', 'redis');
    expect(result.value).toHaveProperty('REDIS_PORT', 6379);
    expect(result.value).toHaveProperty('QUEUE_PREFIX', 'streamtube');
  });
});

describe('test environment isolation (setup-test-env)', () => {
  it('should point queue and buckets to the test namespaces', () => {
    expect(process.env.QUEUE_PREFIX).toBe('streamtube-test');
    expect(process.env.S3_BUCKET_VIDEOS).toBe('videos-test');
    expect(process.env.S3_BUCKET_THUMBNAILS).toBe('thumbnails-test');
  });

  it('should sign public URLs with the internal endpoint', () => {
    expect(process.env.S3_ENDPOINT).toBeDefined();
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe(process.env.S3_ENDPOINT);
  });
});
