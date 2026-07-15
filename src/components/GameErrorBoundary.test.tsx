import { describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ reportClientRuntimeError: vi.fn() }))

vi.mock('../runtimeErrors', () => runtime)

import { GameErrorBoundary } from './GameErrorBoundary'

describe('GameErrorBoundary runtime reporting', () => {
  it('passes only the bounded code plus the error identity to the shared reporter', () => {
    const error = new Error('private render diagnostic')
    const boundary = new GameErrorBoundary({ children: null })

    boundary.componentDidCatch(error)

    expect(runtime.reportClientRuntimeError).toHaveBeenCalledWith({
      cause: error,
      code: 'render_failure',
    })
  })
})
