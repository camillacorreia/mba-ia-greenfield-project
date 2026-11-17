import { defaultTitleFromFilename } from './video-title.util';

describe('defaultTitleFromFilename', () => {
  it.each([
    ['aula.mp4', 'aula'],
    ['minha.aula.final.webm', 'minha.aula.final'],
    ['sem-extensao', 'sem-extensao'],
    ['  com espaços .mp4', 'com espaços'],
  ])('should turn %p into %p', (filename, expected) => {
    expect(defaultTitleFromFilename(filename)).toBe(expected);
  });

  it('should fall back to the whole file name when only the extension is left', () => {
    expect(defaultTitleFromFilename('.mp4')).toBe('.mp4');
  });

  it('should fall back to "video" when the name is blank', () => {
    expect(defaultTitleFromFilename('   ')).toBe('video');
  });

  it('should truncate the title to 100 characters', () => {
    const title = defaultTitleFromFilename(`${'a'.repeat(150)}.mp4`);

    expect(title).toHaveLength(100);
    expect(title).toBe('a'.repeat(100));
  });
});
