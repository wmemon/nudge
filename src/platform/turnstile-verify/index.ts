import { config } from '../config/index.js'
import { InternalError } from '../../shared/errors/index.js'

// Cloudflare Turnstile siteverify endpoint (server-side validation)
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Verifies a Cloudflare Turnstile token against the siteverify API.
 *
 * Returns { success: true } when the token is valid.
 * Returns { success: false } when the token is invalid, expired, or already used.
 * Throws InternalError on network failure, non-2xx HTTP, or Cloudflare internal-error —
 * callers should surface this as a 500 so the client can retry with a fresh token.
 *
 * Tokens are single-use and expire after 5 minutes (Cloudflare enforced).
 * Never call this twice for the same token — the second call will return
 * { success: false } with error-code "timeout-or-duplicate".
 *
 * The token is never logged (OAC-002).
 */
export async function verifyCaptcha(token: string): Promise<{ success: boolean }> {
  let response: Response
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.TURNSTILE_SECRET_KEY, response: token }),
    })
  } catch {
    throw new InternalError('Turnstile verification failed — network error')
  }

  if (!response.ok) {
    throw new InternalError(`Turnstile verification failed — HTTP ${response.status.toString()}`)
  }

  const result = await response.json() as { success: boolean; 'error-codes'?: string[] }

  // Cloudflare internal-error: the token has NOT been consumed — safe to retry.
  // Throw so the caller surfaces a 500 and the client can submit a fresh token.
  if (result['error-codes']?.includes('internal-error')) {
    throw new InternalError('Turnstile verification failed — Cloudflare internal error, please retry')
  }

  return { success: result.success }
}
