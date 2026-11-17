import { attachmentDisposition } from './content-disposition.util';

describe('attachmentDisposition', () => {
  it('should use only filename for an ASCII name', () => {
    expect(attachmentDisposition('aula.mp4')).toBe(
      'attachment; filename="aula.mp4"',
    );
  });

  it('should add filename* with UTF-8 percent-encoding for a non-ASCII name', () => {
    expect(attachmentDisposition('vídeo final.mp4')).toBe(
      `attachment; filename="v_deo final.mp4"; filename*=UTF-8''v%C3%ADdeo%20final.mp4`,
    );
  });

  it('should escape the characters RFC 8187 requires in filename*', () => {
    expect(attachmentDisposition("café (o'brien)!.mp4")).toContain(
      `filename*=UTF-8''caf%C3%A9%20%28o%27brien%29%21.mp4`,
    );
  });

  it('should strip quotes, backslashes and line breaks', () => {
    const header = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1.mp4');

    expect(header).toBe('attachment; filename="abcSet-Cookie: x=1.mp4"');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('should fall back to a default name when nothing usable is left', () => {
    expect(attachmentDisposition('""\r\n')).toBe(
      'attachment; filename="video"',
    );
  });
});
