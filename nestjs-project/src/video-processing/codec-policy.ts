import type { ProbeResult } from './media-inspector.service';

export type PlayabilityFailure =
  | 'INVALID_MEDIA'
  | 'UNSUPPORTED_CONTAINER'
  | 'UNSUPPORTED_CODEC';

export type PlayabilityResult = 'ok' | PlayabilityFailure;

interface FormatPolicy {
  /** Nome que precisa aparecer em `format_name` do ffprobe (lista separada por vírgula). */
  container: string;
  videoCodecs: readonly string[];
  /** Áudio ausente é aceito nos dois formatos. */
  audioCodecs: readonly string[];
}

/** Allowlist da TD-08, por content type declarado no upload. */
const FORMAT_POLICIES: Record<string, FormatPolicy> = {
  'video/mp4': {
    container: 'mp4',
    videoCodecs: ['h264'],
    audioCodecs: ['aac', 'mp3'],
  },
  'video/webm': {
    container: 'webm',
    videoCodecs: ['vp8', 'vp9', 'av1'],
    audioCodecs: ['opus', 'vorbis'],
  },
};

const THUMBNAIL_POSITION_RATIO = 0.1;
const THUMBNAIL_MAX_SECONDS = 5;

export function checkPlayability(
  contentType: string,
  probe: ProbeResult,
): PlayabilityResult {
  if (!probe.video || !probe.durationSeconds || probe.durationSeconds <= 0) {
    return 'INVALID_MEDIA';
  }

  const policy = FORMAT_POLICIES[contentType];
  const containers = probe.formatName.split(',');
  if (!policy || !containers.includes(policy.container)) {
    return 'UNSUPPORTED_CONTAINER';
  }

  if (!policy.videoCodecs.includes(probe.video.codec)) {
    return 'UNSUPPORTED_CODEC';
  }
  if (probe.audio && !policy.audioCodecs.includes(probe.audio.codec)) {
    return 'UNSUPPORTED_CODEC';
  }
  return 'ok';
}

/** Frame da thumbnail: 10% da duração, limitado a 5s (TD-05). */
export function thumbnailTimestamp(durationSeconds: number): number {
  return Math.min(
    durationSeconds * THUMBNAIL_POSITION_RATIO,
    THUMBNAIL_MAX_SECONDS,
  );
}
