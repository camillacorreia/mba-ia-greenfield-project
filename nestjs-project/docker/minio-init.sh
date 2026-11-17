#!/bin/sh
# Prepara os buckets do MinIO. Idempotente: pode rodar a cada `docker compose up`.
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

for bucket in videos thumbnails videos-test thumbnails-test; do
  mc mb --ignore-existing "local/$bucket"
done

# Thumbnails são de leitura pública anônima; vídeos ficam privados (só URL pré-assinada).
for bucket in thumbnails thumbnails-test; do
  mc anonymous set download "local/$bucket"
done

# Multipart incompleto é abortado pelo storage depois de 1 dia. O MinIO não aceita a regra
# de lifecycle AbortIncompleteMultipartUpload; ele faz essa limpeza pela config do servidor.
mc admin config set local api stale_uploads_expiry=24h
