import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1794934411093 } from './migrations/1794934411093-CreateVideos';
import { AddTitleAndStorageKeyToVideos1794938125601 } from './migrations/1794938125601-AddTitleAndStorageKeyToVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Postgres types created by `CREATE TYPE` in the migrations. They survive
// `DROP TABLE ... CASCADE`, so they must be dropped explicitly or the next
// `runMigrations()` fails with `type "..." already exists`. When a new
// migration creates an enum, add its type name here.
const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1794934411093,
          AddTitleAndStorageKeyToVideos1794938125601,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${type}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The revert tests undo migrations, leaving tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    // Destroy in `finally`: if re-migrating fails, an open pool keeps Jest alive.
    try {
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(4);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the videos_status_enum type', async () => {
    const result = await dataSource.query<{ value: string }[]>(
      `SELECT unnest(enum_range(NULL::"public"."videos_status_enum"))::text AS value`,
    );

    expect(result.map((r) => r.value)).toEqual([
      'draft',
      'processing',
      'ready',
      'failed',
    ]);
  });

  async function videoColumns(): Promise<
    { column_name: string; is_nullable: string }[]
  > {
    return dataSource.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'videos' AND column_name IN ('title', 'storage_key')
       ORDER BY column_name`,
    );
  }

  it('should add title and storage_key as NOT NULL columns', async () => {
    await expect(videoColumns()).resolves.toEqual([
      { column_name: 'storage_key', is_nullable: 'NO' },
      { column_name: 'title', is_nullable: 'NO' },
    ]);
  });

  it('should revert AddTitleAndStorageKeyToVideos and remove both columns', async () => {
    await dataSource.undoLastMigration();

    await expect(videoColumns()).resolves.toEqual([]);
  });

  it('should backfill title and storage_key for videos created before the migration', async () => {
    const [user] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "users" ("email", "password") VALUES ('legacy-videos@example.com', 'x') RETURNING "id"`,
    );
    const [channel] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "channels" ("name", "nickname", "user_id") VALUES ('legacy', 'legacy-videos', $1) RETURNING "id"`,
      [user.id],
    );
    const longName = `${'a'.repeat(150)}.mp4`;
    for (const [publicId, filename] of [
      ['legacy00001', 'aula.mp4'],
      ['legacy00002', '.mp4'],
      ['legacy00003', longName],
    ]) {
      await dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "original_filename", "content_type", "size_bytes")
         VALUES ($1, $2, $3, 'video/mp4', 1)`,
        [publicId, channel.id, filename],
      );
    }

    const ran = await dataSource.runMigrations();
    const rows = await dataSource.query<
      { public_id: string; title: string; key_matches_id: boolean }[]
    >(
      `SELECT "public_id", "title", "storage_key" = "id"::text AS key_matches_id
       FROM "videos" WHERE "channel_id" = $1 ORDER BY "public_id"`,
      [channel.id],
    );

    expect(ran.map((migration) => migration.name)).toEqual([
      'AddTitleAndStorageKeyToVideos1794938125601',
    ]);
    expect(rows).toEqual([
      { public_id: 'legacy00001', title: 'aula', key_matches_id: true },
      { public_id: 'legacy00002', title: '.mp4', key_matches_id: true },
      {
        public_id: 'legacy00003',
        title: 'a'.repeat(100),
        key_matches_id: true,
      },
    ]);

    await dataSource.query('DELETE FROM "videos" WHERE "channel_id" = $1', [
      channel.id,
    ]);
    await dataSource.query('DELETE FROM "channels" WHERE "id" = $1', [
      channel.id,
    ]);
    await dataSource.query('DELETE FROM "users" WHERE "id" = $1', [user.id]);
    await dataSource.undoLastMigration();
  });

  it('should revert CreateVideos and remove the videos table and its enum', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(tables).toHaveLength(0);
    expect(types).toHaveLength(0);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
