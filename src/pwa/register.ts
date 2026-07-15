import {
  monitorPracticeConnectivity,
  updatePracticeAvailability,
} from './status'

interface PracticeWorkerContainer {
  ready: Promise<ServiceWorkerRegistration>
  register(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistration>
}

export interface RegisterPracticeWorkerOptions {
  enabled?: boolean
  serviceWorker?: PracticeWorkerContainer | null
}

export function shouldRegisterPracticeWorker(
  enabled: boolean,
  serviceWorkerSupported: boolean,
): boolean {
  return enabled && serviceWorkerSupported
}

export async function registerPracticeServiceWorker(
  options: RegisterPracticeWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  const enabled = options.enabled ?? import.meta.env.PROD
  monitorPracticeConnectivity()

  if (!enabled) {
    updatePracticeAvailability({ phase: 'disabled' })
    return null
  }

  const serviceWorker = options.serviceWorker
    ?? (typeof navigator === 'undefined' ? null : navigator.serviceWorker)
  if (!shouldRegisterPracticeWorker(enabled, Boolean(serviceWorker)) || !serviceWorker) {
    updatePracticeAvailability({ phase: 'unsupported' })
    return null
  }

  updatePracticeAvailability({ phase: 'installing' })
  try {
    const registration = await serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
    await serviceWorker.ready
    updatePracticeAvailability({ phase: 'ready' })
    return registration
  } catch {
    updatePracticeAvailability({ phase: 'error' })
    return null
  }
}
