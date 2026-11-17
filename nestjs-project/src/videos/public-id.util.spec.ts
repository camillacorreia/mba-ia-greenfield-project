import { generatePublicId, isValidPublicId } from './public-id.util';

describe('public-id.util', () => {
  describe('generatePublicId', () => {
    it('should generate 11-character ids from the base64url alphabet', () => {
      const ids = Array.from({ length: 500 }, () => generatePublicId());

      for (const id of ids) {
        expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      }
    });

    it('should generate distinct ids across calls', () => {
      const ids = new Set(
        Array.from({ length: 500 }, () => generatePublicId()),
      );

      expect(ids.size).toBe(500);
    });
  });

  describe('isValidPublicId', () => {
    it('should accept a generated id', () => {
      expect(isValidPublicId(generatePublicId())).toBe(true);
    });

    it('should accept ids using - and _', () => {
      expect(isValidPublicId('a-b_c-d_e-f')).toBe(true);
    });

    it.each([
      ['too short', 'abcdefghij'],
      ['too long', 'abcdefghijkl'],
      ['standard base64 characters', 'abcdefghi+/'],
      ['padding', 'abcdefghij='],
      ['empty', ''],
      ['uuid', '6f1c1b7e-3f0a-4c55-9d4e-2b8f1a6c9e10'],
    ])('should reject %s', (_label, value) => {
      expect(isValidPublicId(value)).toBe(false);
    });
  });
});
