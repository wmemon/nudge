// ── Base error class ───────────────────────────────────────────────────────────

export class AppError extends Error {
  public readonly code: string
  public readonly httpStatus: number
  public readonly details: Array<{ field?: string; message: string }>

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details: Array<{ field?: string; message: string }> = [],
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

// ── Typed error subtypes ───────────────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(
    details: Array<{ field?: string; message: string }>,
    message = 'Validation failed',
  ) {
    super('VALIDATION_ERROR', message, 400, details)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404)
    this.name = 'NotFoundError'
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403)
    this.name = 'ForbiddenError'
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super('CONFLICT', message, 409)
    this.name = 'ConflictError'
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super('INTERNAL_ERROR', message, 500)
    this.name = 'InternalError'
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super('SERVICE_UNAVAILABLE', message, 503)
    this.name = 'ServiceUnavailableError'
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests') {
    super('TOO_MANY_REQUESTS', message, 429)
    this.name = 'TooManyRequestsError'
  }
}

// ── Error envelope (contracts-first §8) ───────────────────────────────────────
//
// Every error response across all routes uses this shape:
//
//   {
//     "error": { "code": "...", "message": "..." },
//     "requestId": "...",
//     "details": []
//   }

export interface ErrorEnvelope {
  error: { code: string; message: string }
  requestId: string
  details: Array<{ field?: string; message: string }>
}

export function toErrorEnvelope(error: AppError, requestId: string): ErrorEnvelope {
  return {
    error: { code: error.code, message: error.message },
    requestId,
    details: error.details,
  }
}
