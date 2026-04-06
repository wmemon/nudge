import { v4 as uuidv4 } from 'uuid'

/**
 * Generates a new UUID v4 request ID.
 * Used when no x-request-id header is present (OAC-001).
 */
export function generateRequestId(): string {
  return uuidv4()
}

/**
 * Extracts the request ID from an x-request-id header value.
 * Returns undefined if the header is absent or empty.
 */
export function extractFromHeader(
  headerValue: string | string[] | undefined,
): string | undefined {
  if (!headerValue) return undefined
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue
  return value.trim() || undefined
}
