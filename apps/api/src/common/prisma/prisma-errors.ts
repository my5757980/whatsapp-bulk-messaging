import { Prisma } from '../../generated/prisma/client.js';

/** Unique constraint violation (P2002), e.g. a duplicate dedupe key or phone number. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Micro-dollars (integer) to a USD number for API responses. */
export function microsToUsd(micros: bigint | number | null | undefined): number {
  if (micros === null || micros === undefined) return 0;
  return Number(micros) / 1_000_000;
}
