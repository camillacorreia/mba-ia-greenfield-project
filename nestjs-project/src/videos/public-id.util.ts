import { randomBytes } from 'node:crypto';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 8 bytes aleatórios viram exatamente 11 caracteres em base64url (sem padding).
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

export function isValidPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
