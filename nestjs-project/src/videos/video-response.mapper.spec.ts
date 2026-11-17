import { Video, VideoStatus } from './entities/video.entity';
import { toVideoResponse } from './video-response.mapper';

const thumbnailUrlFor = (key: string) =>
  `http://localhost:9000/thumbnails/${key}`;

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: '6f1c1b7e-3f0a-4c55-9d4e-2b8f1a6c9e10',
    public_id: 'dQw4w9WgXcQ',
    channel_id: 'f5b0f2a4-8d2e-4a7a-9e0b-1c2d3e4f5a6b',
    status: VideoStatus.DRAFT,
    failure_reason: null,
    original_filename: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 5000000,
    upload_id: 'multipart-upload-id',
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: null,
    thumbnail_key: null,
    created_at: new Date('2026-11-17T12:00:00Z'),
    updated_at: new Date('2026-11-17T12:00:05Z'),
    ...overrides,
  } as Video;
}

describe('toVideoResponse', () => {
  it('should never expose id, channel_id nor upload_id', () => {
    const response = toVideoResponse(video(), thumbnailUrlFor);

    expect(response).not.toHaveProperty('id');
    expect(response).not.toHaveProperty('channel_id');
    expect(response).not.toHaveProperty('upload_id');
    expect(response).not.toHaveProperty('thumbnail_key');
  });

  it('should return a null thumbnail_url without thumbnail_key', () => {
    expect(toVideoResponse(video(), thumbnailUrlFor).thumbnail_url).toBeNull();
  });

  it('should build thumbnail_url from the thumbnail_key', () => {
    const response = toVideoResponse(
      video({
        status: VideoStatus.READY,
        thumbnail_key: '6f1c1b7e-3f0a-4c55-9d4e-2b8f1a6c9e10.jpg',
      }),
      thumbnailUrlFor,
    );

    expect(response.thumbnail_url).toBe(
      'http://localhost:9000/thumbnails/6f1c1b7e-3f0a-4c55-9d4e-2b8f1a6c9e10.jpg',
    );
  });

  it('should return size_bytes as a number even if the driver gives a string', () => {
    const response = toVideoResponse(
      video({ size_bytes: '10737418240' as unknown as number }),
      thumbnailUrlFor,
    );

    expect(response.size_bytes).toBe(10737418240);
  });

  it('should format dates as ISO-8601 strings', () => {
    const response = toVideoResponse(video(), thumbnailUrlFor);

    expect(response.created_at).toBe('2026-11-17T12:00:00.000Z');
    expect(response.updated_at).toBe('2026-11-17T12:00:05.000Z');
  });

  it('should expose failure_reason and processing metadata', () => {
    const response = toVideoResponse(
      video({
        status: VideoStatus.FAILED,
        failure_reason: 'UNSUPPORTED_CODEC',
        duration_seconds: 1.5,
        width: 320,
        height: 240,
        video_codec: 'mpeg4',
      }),
      thumbnailUrlFor,
    );

    expect(response).toMatchObject({
      status: 'failed',
      failure_reason: 'UNSUPPORTED_CODEC',
      duration_seconds: 1.5,
      width: 320,
      height: 240,
      video_codec: 'mpeg4',
      audio_codec: null,
    });
  });
});
