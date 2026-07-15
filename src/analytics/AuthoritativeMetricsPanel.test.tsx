import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuthoritativeMetricsPanel } from './AuthoritativeMetricsPanel'

describe('AuthoritativeMetricsPanel', () => {
  it('keeps central access explicitly operator-only and handles an absent API', () => {
    const configured = renderToStaticMarkup(
      <AuthoritativeMetricsPanel baseUrl="https://alpha.example" />,
    )
    expect(configured).toContain('Operator aggregate')
    expect(configured).toContain('type="password"')
    expect(configured).toContain('never stored')

    const absent = renderToStaticMarkup(<AuthoritativeMetricsPanel baseUrl={null} />)
    expect(absent).toContain('No service endpoint configured')
  })
})
