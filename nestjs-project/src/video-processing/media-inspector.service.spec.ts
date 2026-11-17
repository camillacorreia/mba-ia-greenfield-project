import { parseProbeOutput } from './media-inspector.service';

describe('MediaInspector', () => {
  describe('parseProbeOutput', () => {
    it('should map format and streams regardless of stream order', () => {
      const result = parseProbeOutput({
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '1.534000',
        },
        streams: [
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
        ],
      });

      expect(result).toEqual({
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        durationSeconds: 1.534,
        video: { codec: 'h264', width: 320, height: 240 },
        audio: { codec: 'aac' },
      });
    });

    it('should return audio null when there is no audio stream', () => {
      const result = parseProbeOutput({
        format: { format_name: 'matroska,webm', duration: '2.0' },
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 640, height: 360 },
        ],
      });

      expect(result.audio).toBeNull();
    });

    it('should ignore an embedded cover image when picking the video stream', () => {
      const result = parseProbeOutput({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            width: 600,
            height: 600,
            disposition: { attached_pic: 1 },
          },
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
          },
        ],
      });

      expect(result.video).toEqual({
        codec: 'h264',
        width: 1920,
        height: 1080,
      });
    });

    it('should fall back to the video stream duration when the format has none', () => {
      const result = parseProbeOutput({
        format: { format_name: 'matroska,webm' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'vp8',
            width: 640,
            height: 360,
            duration: '3.25',
          },
        ],
      });

      expect(result.durationSeconds).toBe(3.25);
    });

    it('should return null duration and video for output without streams', () => {
      const result = parseProbeOutput({ format: { duration: 'N/A' } });

      expect(result).toEqual({
        formatName: '',
        durationSeconds: null,
        video: null,
        audio: null,
      });
    });
  });
});
