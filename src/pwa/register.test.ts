import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPracticeServiceWorker, shouldRegisterPracticeWorker } from './register'
import {
  canOpenRanked,
  defaultPlayMode,
  getPracticeAvailability,
  updatePracticeAvailability,
} from './status'

describe('practice service worker registration', () => {
  beforeEach(() => {
    updatePracticeAvailability({ phase: 'idle', online: true })
  })

  it('is gated to supported production builds', () => {
    expect(shouldRegisterPracticeWorker(false, true)).toBe(false)
    expect(shouldRegisterPracticeWorker(true, false)).toBe(false)
    expect(shouldRegisterPracticeWorker(true, true)).toBe(true)
  })

  it('registers at the root without consulting HTTP cache', async () => {
    const registration = {} as ServiceWorkerRegistration
    const register = vi.fn().mockResolvedValue(registration)
    const result = await registerPracticeServiceWorker({
      enabled: true,
      serviceWorker: {
        ready: Promise.resolve(registration),
        register,
      },
    })

    expect(result).toBe(registration)
    expect(register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
    expect(getPracticeAvailability().phase).toBe('ready')
  })

  it('fails closed without making offline readiness claims', async () => {
    await registerPracticeServiceWorker({
      enabled: true,
      serviceWorker: {
        ready: new Promise<ServiceWorkerRegistration>(() => undefined),
        register: vi.fn().mockRejectedValue(new Error('blocked')),
      },
    })
    expect(getPracticeAvailability().phase).toBe('error')
  })
})

describe('ranked connectivity guard', () => {
  it('requires both a configured endpoint and a live connection', () => {
    expect(canOpenRanked('/api', true)).toBe(true)
    expect(canOpenRanked('/api', false)).toBe(false)
    expect(canOpenRanked(null, true)).toBe(false)
    expect(defaultPlayMode('/api', true)).toBe('ranked')
    expect(defaultPlayMode('/api', false)).toBe('practice')
    expect(defaultPlayMode(null, true)).toBe('practice')
  })
})
