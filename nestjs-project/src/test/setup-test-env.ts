// Roda em toda suíte Jest, logo depois de `dotenv/config`: isola fila e buckets de teste
// dos de runtime. O cliente dos testes está dentro da rede do Compose, então a URL
// pré-assinada pública usa o mesmo endpoint interno.
process.env.QUEUE_PREFIX = 'streamtube-test';
process.env.S3_BUCKET_VIDEOS = 'videos-test';
process.env.S3_BUCKET_THUMBNAILS = 'thumbnails-test';
if (process.env.S3_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
