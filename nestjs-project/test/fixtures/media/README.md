# Fixtures de mídia

Arquivos pequenos (1,5s, menos de 25 KB) usados pelos testes de processamento de vídeo
(`MediaInspector`, `codec-policy`, worker). Gerados uma vez dentro do container
`nestjs-api` (ffmpeg version 5.1.9-0+deb12u1) a partir das fontes sintéticas do ffmpeg (`testsrc` e `sine`)
e commitados. Para regerar, rode os comandos abaixo a partir desta pasta:

```bash
docker compose exec nestjs-api sh -c 'cd test/fixtures/media && <comando>'
```

| Arquivo | Conteúdo | Papel nos testes |
|---------|----------|------------------|
| `sample-h264-aac.mp4` | MP4, vídeo h264 320x240 15fps, áudio aac | caso feliz MP4; container divergente quando declarado como `video/webm` |
| `sample-vp9-opus.webm` | WebM, vídeo vp9 320x240 15fps, áudio opus | caso feliz WebM |
| `sample-mpeg4.mp4` | MP4, vídeo MPEG-4 Part 2, sem áudio | codec fora da allowlist (`UNSUPPORTED_CODEC`) |
| `not-a-video.mp4` | texto puro com extensão .mp4 | arquivo ilegível (`MediaUnreadableError` / `INVALID_MEDIA`) |

## Comandos

```bash
ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=15:duration=1.5 \
  -f lavfi -i sine=frequency=440:duration=1.5 \
  -c:v libx264 -preset veryslow -crf 35 -pix_fmt yuv420p \
  -c:a aac -b:a 32k -movflags +faststart -shortest sample-h264-aac.mp4

ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=15:duration=1.5 \
  -f lavfi -i sine=frequency=440:duration=1.5 \
  -c:v libvpx-vp9 -b:v 0 -crf 50 -deadline good \
  -c:a libopus -b:a 24k -shortest sample-vp9-opus.webm

ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=15:duration=1.5 \
  -c:v mpeg4 -q:v 15 -an sample-mpeg4.mp4

printf "This is a plain text file, not a video.\n" > not-a-video.mp4
```
