/** Tamanho máximo do título (coluna `videos.title`, varchar(100)). */
export const VIDEO_TITLE_MAX_LENGTH = 100;

const FALLBACK_TITLE = 'video';

/**
 * Título do rascunho quando o `POST /videos` não informa um: o nome do arquivo
 * sem a última extensão, truncado em 100. Se não sobrar nada (ex.: `.mp4`), usa
 * o próprio nome; por último, `video`. Mesma regra da migration
 * AddTitleAndStorageKeyToVideos para as linhas já existentes.
 */
export function defaultTitleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]*$/, '').trim();
  const title = withoutExtension || filename.trim() || FALLBACK_TITLE;
  return title.slice(0, VIDEO_TITLE_MAX_LENGTH);
}
