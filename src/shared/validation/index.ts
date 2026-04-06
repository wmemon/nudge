import { z } from 'zod'
import { ValidationError } from '../errors/index.js'

export { z }
export type { ZodSchema, ZodError, infer as Infer } from 'zod'

/**
 * Parses `data` against `schema`, throwing a `ValidationError` on failure.
 * Use at system boundaries (HTTP request bodies, queue job payloads).
 *
 * @example
 *   const body = parseOrThrow(MySchema, request.body)
 */
export function parseOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (result.success) return result.data

  const details = result.error.errors.map((e) => ({
    field: e.path.join('.') || undefined,
    message: e.message,
  }))

  throw new ValidationError(details)
}

/**
 * Parses `data` against `schema`, returning `null` on failure instead of throwing.
 * Useful when partial data is acceptable or you need to branch on validity.
 */
export function parseSafe<T>(schema: z.ZodSchema<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  return result.success ? result.data : null
}
