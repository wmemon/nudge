// MBC-002: This is the ONLY file permitted to import 'openai'.
// ESLint will error on any other file that imports from 'openai'.
//
// OpenRouter uses the OpenAI SDK with a custom baseURL — no @anthropic-ai/sdk needed.
// Fallback between primary and fallback models is handled by OpenRouter natively
// via the `models` array in the request body.

import OpenAI from 'openai'
import { config } from '../config/index.js'
import { createLogger } from '../observability/index.js'
import { InternalError } from '../../shared/errors/index.js'
import type { LLMRequest, LLMResponse, NLUOutcome, OnboardingRequest, OnboardingResponse } from './index.js'

const log = createLogger({ module: 'openrouter-adapter' })

// ── OpenRouter client (singleton) ────────────────────────────────────────────

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (_client) return _client
  _client = new OpenAI({
    apiKey:  config.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    timeout: 30_000,
  })
  return _client
}

// ── JSON schema for structured output ────────────────────────────────────────
//
// OpenRouter enforces this schema on the response body when response_format
// is set to json_schema. Both anthropic/claude-sonnet-4-6 and openai/gpt-4o
// support structured outputs.

const RESPONSE_SCHEMA = {
  name: 'nudge_turn_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'The conversational reply to send to the user via iMessage.',
      },
      outcome: {
        type: 'object',
        properties: {
          classification: {
            type: 'string',
            enum: ['done', 'not_done', 'unclear'],
            description: 'Whether the user completed their goal in this message.',
          },
          confidence: {
            type: 'number',
            description: 'Model confidence in the classification, 0–1.',
          },
        },
        required: ['classification'],
        additionalProperties: false,
      },
    },
    required: ['reply', 'outcome'],
    additionalProperties: false,
  },
}

// ── System prompt ─────────────────────────────────────────────────────────────
//
// TODO: replace with final product copy when available.
// This is a functional placeholder that produces correct structured output.

const SYSTEM_PROMPT = `You are Nudge, a supportive iMessage accountability companion.
Your job is to respond warmly and briefly to the user's check-in message, then classify
whether they completed their goal.

- "reply": a short, warm iMessage reply (1–3 sentences max)
- "outcome.classification": "done" if they completed their goal, "not_done" if they
  explicitly did not, or "unclear" if it cannot be determined from the message
- "outcome.confidence": your confidence in the classification (0.0–1.0)

Never log or repeat back sensitive personal details. Keep replies concise.`

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Sends a chat completion request to OpenRouter.
 *
 * Uses the `models` array so OpenRouter automatically falls back from the
 * primary model to the fallback model on provider errors — no retry logic needed.
 *
 * Content is never logged (OAC-002).
 */
export async function openrouterComplete(request: LLMRequest): Promise<LLMResponse> {
  const client = getClient()
  const { correlationId } = request

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...request.messages,
  ]

  // `models` is an OpenRouter extension passed through the request body.
  // The OpenAI SDK forwards unknown top-level fields, so this works correctly.
  let completion: OpenAI.Chat.ChatCompletion
  try {
    completion = await client.chat.completions.create({
      // @ts-expect-error — `models` is an OpenRouter extension not in the OpenAI type defs
      models: [config.OPENROUTER_PRIMARY_MODEL, config.OPENROUTER_FALLBACK_MODEL],
      messages,
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.7,
      response_format: {
        type: 'json_schema',
        json_schema: RESPONSE_SCHEMA,
      },
    })
  } catch (err) {
    log.error({ event: 'openrouter.request.failed', correlationId, err })
    throw err
  }

  const rawContent = completion.choices[0]?.message?.content
  if (!rawContent) {
    throw new InternalError('OpenRouter returned an empty response')
  }

  // Parse structured output — throw InternalError so the job retries on malformed JSON
  let parsed: { reply: string; outcome: { classification: string; confidence?: number } }
  try {
    parsed = JSON.parse(rawContent) as typeof parsed
  } catch {
    throw new InternalError('OpenRouter response was not valid JSON')
  }

  const classification = parsed.outcome?.classification
  if (classification !== 'done' && classification !== 'not_done' && classification !== 'unclear') {
    throw new InternalError(`Unexpected NLU classification: ${String(classification)}`)
  }

  const nluOutcome: NLUOutcome = {
    outcomeType: 'accountability_check',
    classification,
    confidence: parsed.outcome.confidence,
  }

  return {
    content: parsed.reply,
    nluOutcome,
    usage: {
      promptTokens:     completion.usage?.prompt_tokens     ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

// ── Onboarding mode ───────────────────────────────────────────────────────────

const ONBOARDING_SCHEMA = {
  name: 'nudge_onboarding_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'The conversational reply to send to the user via iMessage.',
      },
      goalCapture: {
        type: 'object',
        properties: {
          detected: {
            type: 'boolean',
            description: 'True only when the user has stated a clear goal AND a preferred check-in time.',
          },
          goalText: {
            type: 'string',
            description: 'The goal statement extracted from the conversation. Empty string when detected is false.',
          },
          checkInTime: {
            type: 'string',
            description: 'Preferred check-in time as "HH:MM" in 24h format. Empty string when not mentioned.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone string inferred from the conversation (e.g. "America/New_York"). Empty string when not determinable.',
          },
        },
        required: ['detected', 'goalText', 'checkInTime', 'timezone'],
        additionalProperties: false,
      },
    },
    required: ['reply', 'goalCapture'],
    additionalProperties: false,
  },
}

// TODO: replace with final product copy when available.
const ONBOARDING_SYSTEM_PROMPT = `You are Nudge, a warm and encouraging iMessage accountability companion.
The user is in the onboarding phase — they have not yet set a goal.

Your job:
1. Have a friendly, natural conversation to help the user identify one habit or goal they want to work on.
2. Once the user has clearly stated a goal, ask them what time of day they'd like to be checked in on it.
3. When you have BOTH a clear goal statement AND a preferred check-in time, set goalCapture.detected to true
   and fill in goalText, checkInTime (as "HH:MM" in 24h format), and timezone (infer from context clues
   like timezone names or city mentions; use empty string if unknown).

Rules:
- Set goalCapture.detected to false until you have both a goal AND a time. Do not rush it.
- goalText, checkInTime, and timezone must be empty strings when detected is false.
- Keep replies short and conversational (1–3 sentences). This is iMessage, not email.
- Never log or repeat back sensitive personal details.`

/**
 * Sends an onboarding-mode completion request to OpenRouter.
 *
 * Used when the recipient has no active goal yet. The response includes a
 * goalCapture block that signals when the LLM has extracted a goal + schedule.
 *
 * Content is never logged (OAC-002).
 */
export async function openrouterCompleteOnboarding(
  request: OnboardingRequest,
): Promise<OnboardingResponse> {
  const client = getClient()
  const { correlationId } = request

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: ONBOARDING_SYSTEM_PROMPT },
    ...request.messages,
  ]

  let completion: OpenAI.Chat.ChatCompletion
  try {
    completion = await client.chat.completions.create({
      // @ts-expect-error — `models` is an OpenRouter extension not in the OpenAI type defs
      models: [config.OPENROUTER_PRIMARY_MODEL, config.OPENROUTER_FALLBACK_MODEL],
      messages,
      max_tokens: 512,
      temperature: 0.7,
      response_format: {
        type: 'json_schema',
        json_schema: ONBOARDING_SCHEMA,
      },
    })
  } catch (err) {
    log.error({ event: 'openrouter.onboarding.failed', correlationId, err })
    throw err
  }

  const rawContent = completion.choices[0]?.message?.content
  if (!rawContent) {
    throw new InternalError('OpenRouter returned an empty onboarding response')
  }

  let parsed: {
    reply: string
    goalCapture: { detected: boolean; goalText: string; checkInTime: string; timezone: string }
  }
  try {
    parsed = JSON.parse(rawContent) as typeof parsed
  } catch {
    throw new InternalError('OpenRouter onboarding response was not valid JSON')
  }

  // Dummy NLU outcome — lets callers pass this to processInboundTurn unchanged
  const nluOutcome: NLUOutcome = {
    outcomeType:    'onboarding',
    classification: 'unclear',
  }

  return {
    content:     parsed.reply,
    goalCapture: {
      detected:    parsed.goalCapture.detected,
      goalText:    parsed.goalCapture.goalText    ?? '',
      checkInTime: parsed.goalCapture.checkInTime ?? '',
      timezone:    parsed.goalCapture.timezone    ?? '',
    },
    nluOutcome,
    usage: {
      promptTokens:     completion.usage?.prompt_tokens     ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}
