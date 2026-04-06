import { afterEach, describe, expect, it, vi } from 'vitest'

describe('config loader (DPC-001)', () => {
  const saved = { ...process.env }

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
    Object.assign(process.env, saved)
    vi.resetModules()
  })

  it('throws on missing SUPABASE_URL', async () => {
    delete process.env.SUPABASE_URL
    vi.resetModules()
    await expect(import('../../src/platform/config/index.js')).rejects.toThrow(
      'Config validation failed',
    )
  })

  it('throws on missing SUPABASE_SERVICE_ROLE_KEY', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.resetModules()
    await expect(import('../../src/platform/config/index.js')).rejects.toThrow(
      'Config validation failed',
    )
  })

  it('throws when ENFORCE_OUTBOUND_ALLOWLIST is false in non-production', async () => {
    process.env.NODE_ENV = 'development'
    process.env.ENFORCE_OUTBOUND_ALLOWLIST = 'false'
    vi.resetModules()
    await expect(import('../../src/platform/config/index.js')).rejects.toThrow(
      'ENFORCE_OUTBOUND_ALLOWLIST',
    )
  })

  it('loads successfully with valid env vars', async () => {
    vi.resetModules()
    const { config } = await import('../../src/platform/config/index.js')
    expect(config.NODE_ENV).toBe('test')
    expect(config.PORT).toBe(3000)
    expect(Object.isFrozen(config)).toBe(true)
  })
})
