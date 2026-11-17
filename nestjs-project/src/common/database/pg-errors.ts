import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

// QueryFailedError copia os campos do erro do driver pg (code, detail) para si.
type PgQueryFailedError = QueryFailedError & {
  code?: unknown;
  detail?: unknown;
};

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as PgQueryFailedError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
