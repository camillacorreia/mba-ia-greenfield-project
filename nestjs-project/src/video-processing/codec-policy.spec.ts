import { checkPlayability, thumbnailTimestamp } from './codec-policy';
import type { ProbeResult } from './media-inspector.service';

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSeconds: 12,
    video: { codec: 'h264', width: 1280, height: 720 },
    audio: { codec: 'aac' },
    ...overrides,
  };
}

const WEBM = 'matroska,webm';

describe('codec-policy', () => {
  describe('checkPlayability', () => {
    it.each([
      ['video/mp4', 'h264', 'aac'],
      ['video/mp4', 'h264', 'mp3'],
      ['video/webm', 'vp8', 'vorbis'],
      ['video/webm', 'vp9', 'opus'],
      ['video/webm', 'av1', 'opus'],
    ])('should accept %s with %s/%s', (contentType, videoCodec, audioCodec) => {
      const formatName = contentType === 'video/webm' ? WEBM : undefined;

      expect(
        checkPlayability(
          contentType,
          probe({
            ...(formatName && { formatName }),
            video: { codec: videoCodec, width: 640, height: 360 },
            audio: { codec: audioCodec },
          }),
        ),
      ).toBe('ok');
    });

    it.each([
      ['video/mp4', probe({ audio: null })],
      [
        'video/webm',
        probe({
          formatName: WEBM,
          video: { codec: 'vp9', width: 640, height: 360 },
          audio: null,
        }),
      ],
    ])('should accept %s without audio', (contentType, result) => {
      expect(checkPlayability(contentType, result)).toBe('ok');
    });

    it('should reject a container that does not match the declared type', () => {
      expect(checkPlayability('video/webm', probe())).toBe(
        'UNSUPPORTED_CONTAINER',
      );
      expect(
        checkPlayability(
          'video/mp4',
          probe({
            formatName: WEBM,
            video: { codec: 'vp9', width: 640, height: 360 },
          }),
        ),
      ).toBe('UNSUPPORTED_CONTAINER');
    });

    it('should reject a content type outside the allowlist as container', () => {
      expect(checkPlayability('video/quicktime', probe())).toBe(
        'UNSUPPORTED_CONTAINER',
      );
    });

    it('should reject a video codec outside the allowlist', () => {
      expect(
        checkPlayability(
          'video/mp4',
          probe({ video: { codec: 'mpeg4', width: 320, height: 240 } }),
        ),
      ).toBe('UNSUPPORTED_CODEC');
    });

    it('should reject an audio codec outside the allowlist', () => {
      expect(
        checkPlayability('video/mp4', probe({ audio: { codec: 'opus' } })),
      ).toBe('UNSUPPORTED_CODEC');
    });

    it('should reject a file without a video stream', () => {
      expect(checkPlayability('video/mp4', probe({ video: null }))).toBe(
        'INVALID_MEDIA',
      );
    });

    it.each([0, null])('should reject a duration of %s', (durationSeconds) => {
      expect(checkPlayability('video/mp4', probe({ durationSeconds }))).toBe(
        'INVALID_MEDIA',
      );
    });
  });

  describe('thumbnailTimestamp', () => {
    it.each([
      [1.5, 0.15],
      [30, 3],
      [50, 5],
      [3600, 5],
    ])('should pick %ss -> %ss', (duration, expected) => {
      expect(thumbnailTimestamp(duration)).toBeCloseTo(expected);
    });
  });
});
