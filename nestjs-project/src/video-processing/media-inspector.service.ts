import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 120_000;
/** Um frame em JPEG cabe com folga; o limite só protege contra saída inesperada. */
const FRAME_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Largura máxima da thumbnail, mantendo a proporção. */
const THUMBNAIL_MAX_WIDTH = 1280;

export interface ProbeResult {
  formatName: string;
  durationSeconds: number | null;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string } | null;
}

/** O ffprobe não conseguiu ler o arquivo: falha permanente (INVALID_MEDIA). */
export class MediaUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaUnreadableError';
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}

/** Converte a saída JSON do ffprobe (`-show_format -show_streams`) em `ProbeResult`. */
export function parseProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  // Capa embutida (attached_pic) aparece como stream de vídeo, mas não é o vídeo.
  const videoStream = streams.find(
    (stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');

  return {
    formatName: output.format?.format_name ?? '',
    durationSeconds:
      toPositiveNumber(output.format?.duration) ??
      toPositiveNumber(videoStream?.duration),
    video:
      videoStream?.codec_name && videoStream.width && videoStream.height
        ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
          }
        : null,
    audio: audioStream?.codec_name ? { codec: audioStream.codec_name } : null,
  };
}

function toPositiveNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Saída diferente de zero (o processo terminou sozinho), não timeout nem kill.
 * Checagem estrutural em vez de `instanceof Error`: o erro vem do `child_process`
 * e, sob o Jest, é criado em outro realm.
 */
function isNonZeroExit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, killed } = error as { code?: unknown; killed?: boolean };
  return typeof code === 'number' && code !== 0 && killed !== true;
}

/**
 * Lê o vídeo remotamente (URL pré-assinada interna) com ffprobe/ffmpeg via
 * `execFile`, sem baixar o arquivo inteiro (TD-05).
 */
@Injectable()
export class MediaInspector {
  async probe(url: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          url,
        ],
        { timeout: PROBE_TIMEOUT_MS },
      ));
    } catch (error) {
      if (isNonZeroExit(error)) {
        throw new MediaUnreadableError('ffprobe could not read the media', {
          cause: error,
        });
      }
      throw error;
    }

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new MediaUnreadableError('ffprobe returned invalid JSON', {
        cause: error,
      });
    }
    return parseProbeOutput(output);
  }

  /** Extrai um frame em `atSeconds` como JPEG em memória. */
  async extractFrame(url: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        maxBuffer: FRAME_MAX_BUFFER_BYTES,
        timeout: FRAME_TIMEOUT_MS,
      },
    );
    if (stdout.length === 0) {
      throw new Error(`ffmpeg produced no frame at ${atSeconds}s`);
    }
    return stdout;
  }
}
