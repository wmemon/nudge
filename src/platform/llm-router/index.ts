// ── LLM Router ─────────────────────────────────────────────────────────────────
//
// MBC-002: Only openrouter-adapter.ts may import 'openai'.
// The openai npm package is used as the OpenRouter client (custom baseURL).
// @anthropic-ai/sdk is not used — OpenRouter handles model routing and fallback.

export interface LLMRequest {
  /** Conversation messages in OpenAI chat-completion format */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** Max tokens to generate */
  maxTokens?: number
  /** Temperature (0–2) */
  temperature?: number
  /** Correlation ID for tracing this request through logs */
  correlationId?: string
}

export interface NLUOutcome {
  /** Category of the outcome, e.g. 'accountability_check' */
  outcomeType: string
  /** Model's classification of whether the user completed their goal */
  classification: 'done' | 'not_done' | 'unclear'
  /** Optional model confidence score (0–1) */
  confidence?: number
}

export interface LLMResponse {
  /** Reply text to send to the user */
  content: string
  /** Structured NLU outcome extracted from the same LLM call */
  nluOutcome: NLUOutcome
  /** Token usage for metering */
  usage: {
    promptTokens: number
    completionTokens: number
  }
}

// ── Onboarding mode types ─────────────────────────────────────────────────────

export interface OnboardingRequest {
  /** Conversation messages in OpenAI chat-completion format */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** Correlation ID for tracing this request through logs */
  correlationId?: string
}

export interface OnboardingResponse {
  /** Conversational reply to send back to the user */
  content: string
  /**
   * Goal extraction result. `detected` is true only when the LLM has captured
   * both a clear goal statement and a preferred check-in time from the conversation.
   * All string fields are empty string (never null) when detected = false.
   */
  goalCapture: {
    detected:    boolean
    goalText:    string   // goal statement; "" when not yet captured
    checkInTime: string   // "HH:MM" 24h local time; "" when not mentioned
    timezone:    string   // IANA timezone; "" when not mentioned
  }
  /**
   * Dummy NLU outcome so callers can pass this to processInboundTurn unchanged.
   * Always: outcomeType = 'onboarding', classification = 'unclear'.
   */
  nluOutcome: NLUOutcome
  usage: { promptTokens: number; completionTokens: number }
}

// ── Router interface ──────────────────────────────────────────────────────────

export interface LLMRouter {
  complete(request: LLMRequest): Promise<LLMResponse>
  completeOnboarding(request: OnboardingRequest): Promise<OnboardingResponse>
}

/**
 * Creates the LLM router backed by OpenRouter.
 * Model selection and fallback are handled by OpenRouter via the `models` array.
 */
export function createLLMRouter(): LLMRouter {
  // Import lazily to keep the module boundary clean; the real work is in the adapter.
  return {
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const { openrouterComplete } = await import('./openrouter-adapter.js')
      return openrouterComplete(request)
    },
    async completeOnboarding(request: OnboardingRequest): Promise<OnboardingResponse> {
      const { openrouterCompleteOnboarding } = await import('./openrouter-adapter.js')
      return openrouterCompleteOnboarding(request)
    },
  }
}
