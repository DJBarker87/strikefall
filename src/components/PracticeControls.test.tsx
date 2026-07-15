import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  PracticeDifficultySelector,
  PracticeLobbySelector,
  PracticePauseButton,
} from './PracticeControls'

describe('practice controls', () => {
  it('renders keyboard-native 9/19 lobby choices with an explicit selection', () => {
    const html = renderToStaticMarkup(
      <PracticeLobbySelector value={9} onChange={vi.fn()} />,
    )
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Practice bot count"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('9 bots')
    expect(html).toContain('19')
    expect(html).toContain('no network required')
  })

  it('announces pause and resume states without hiding a disabled action', () => {
    const paused = renderToStaticMarkup(
      <PracticePauseButton paused canPause onToggle={vi.fn()} />,
    )
    expect(paused).toContain('aria-label="Resume practice round"')
    expect(paused).toContain('aria-pressed="true"')
    expect(paused).toContain('Resume')

    const disabled = renderToStaticMarkup(
      <PracticePauseButton paused={false} canPause={false} onToggle={vi.fn()} />,
    )
    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain('Pause')
  })

  it('uses native radios to disclose all three public-information bot policies', () => {
    const html = renderToStaticMarkup(
      <PracticeDifficultySelector value="hard" onChange={vi.fn()} />,
    )
    expect(html.match(/type="radio"/g)).toHaveLength(3)
    expect(html).toContain('Practice bot difficulty')
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="hard"/)
    expect(html).toContain('High noise')
    expect(html).toContain('Balanced noise')
    expect(html).toContain('Late crowd forecast')
    expect(html).toContain('No hidden strike data')
  })

  it('keeps a disabled difficulty choice visible and non-interactive', () => {
    const html = renderToStaticMarkup(
      <PracticeDifficultySelector compact disabled value="normal" onChange={vi.fn()} />,
    )
    expect(html).toContain('<fieldset')
    expect(html).toContain('disabled=""')
    expect(html).toContain('practice-difficulty--compact')
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="normal"/)
  })
})
