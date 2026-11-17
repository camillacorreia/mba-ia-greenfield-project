import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTitleAndStorageKeyToVideos1794938125601 implements MigrationInterface {
  name = 'AddTitleAndStorageKeyToVideos1794938125601';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Gerado pelo CLI como ADD ... NOT NULL; ajustado para preencher as linhas
    // existentes antes do NOT NULL (data migration).
    await queryRunner.query(
      `ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "title" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "storage_key" character varying(255)`,
    );
    // Mesma regra do POST /videos sem title: nome do arquivo sem a extensão,
    // truncado em 100; se não sobrar nada, o próprio nome, e por último 'video'.
    await queryRunner.query(
      `UPDATE "videos" SET "title" = left(coalesce(nullif(btrim(regexp_replace("original_filename", '\\.[^.]*$', '')), ''), nullif(btrim("original_filename"), ''), 'video'), 100) WHERE "title" IS NULL`,
    );
    // A chave do original sempre foi o id do vídeo (TD-03).
    await queryRunner.query(
      `UPDATE "videos" SET "storage_key" = "id"::text WHERE "storage_key" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "title" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "storage_key" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN IF EXISTS "storage_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN IF EXISTS "title"`,
    );
  }
}
