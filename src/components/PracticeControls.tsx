import { useId } from 'react'
import { Bot, Pause, Play, ScanSearch } from 'lucide-react'
import type { BotDifficulty, PracticeBotCount } from '../game'
import './practiceControls.css'

export interface PracticeLobbySelectorProps {
  value: PracticeBotCount
  onChange: (count: PracticeBotCount) => void
  disabled?: boolean
  compact?: boolean
}

const LOBBY_OPTIONS: ReadonlyArray<{
  count: PracticeBotCount
  label: string
  detail: string
}> = [
  { count: 9, label: 'Fast cast', detail: 'Every bot style, less crowding.' },
  { count: 19, label: 'Full cast', detail: 'The complete disclosed lobby.' },
]

export function PracticeLobbySelector({
  value,
  onChange,
  disabled = false,
  compact = false,
}: PracticeLobbySelectorProps) {
  return (
    <section
      className={`practice-lobby${compact ? ' practice-lobby--compact' : ''}`}
      aria-labelledby="practice-lobby-title"
    >
      <div className="practice-lobby__heading">
        <span className="practice-lobby__icon" aria-hidden="true">
          <Bot size={18} />
        </span>
        <div>
          <span className="practice-lobby__eyebrow">Offline practice</span>
          <strong id="practice-lobby-title">{compact ? 'Lobby size' : 'Choose your crowd'}</strong>
        </div>
        <output aria-live="polite">{value} bots</output>
      </div>
      <div className="practice-lobby__options" role="group" aria-label="Practice bot count">
        {LOBBY_OPTIONS.map((option) => (
          <button
            key={option.count}
            type="button"
            className="practice-lobby__option"
            aria-label={`${option.count} bots, ${option.label}`}
            aria-pressed={value === option.count}
            disabled={disabled}
            onClick={() => onChange(option.count)}
          >
            <span>
              <strong>{option.count}</strong>
              <small>{option.label}</small>
            </span>
            <em>{option.detail}</em>
          </button>
        ))}
      </div>
      <p>Fresh local path, committed roster, no network required.</p>
    </section>
  )
}

export interface PracticeDifficultySelectorProps {
  value: BotDifficulty
  onChange: (difficulty: BotDifficulty) => void
  disabled?: boolean
  compact?: boolean
}

export const PRACTICE_DIFFICULTY_OPTIONS: ReadonlyArray<{
  value: BotDifficulty
  label: string
  noise: string
  read: string
}> = [
  { value: 'easy', label: 'Easy', noise: 'High noise', read: 'Basic crowd read' },
  { value: 'normal', label: 'Normal', noise: 'Balanced noise', read: 'Live crowd read' },
  { value: 'hard', label: 'Hard', noise: 'Low noise', read: 'Late crowd forecast' },
]

/**
 * Selects a disclosed Practice-only bot policy. Native radios provide keyboard
 * arrow navigation and keep the single-selection relationship unambiguous.
 */
export function PracticeDifficultySelector({
  value,
  onChange,
  disabled = false,
  compact = false,
}: PracticeDifficultySelectorProps) {
  const name = useId()
  const descriptionId = `${name}-description`
  const selected = PRACTICE_DIFFICULTY_OPTIONS.find((option) => option.value === value)

  return (
    <fieldset
      className={`practice-difficulty${compact ? ' practice-difficulty--compact' : ''}`}
      aria-describedby={descriptionId}
      disabled={disabled}
    >
      <legend className="sr-only">Practice bot difficulty</legend>
      <div className="practice-difficulty__heading" aria-hidden="true">
        <span className="practice-difficulty__icon">
          <ScanSearch size={18} />
        </span>
        <span>
          <small>Practice bots</small>
          <strong>Difficulty</strong>
        </span>
        <output>{selected?.label ?? 'Normal'}</output>
      </div>
      <div className="practice-difficulty__options">
        {PRACTICE_DIFFICULTY_OPTIONS.map((option) => (
          <label key={option.value} className="practice-difficulty__option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.noise}</small>
            </span>
            <em>{option.read}</em>
          </label>
        ))}
      </div>
      <p id={descriptionId}>Public flags and revealed candles only. No hidden strike data.</p>
    </fieldset>
  )
}

export interface PracticePauseButtonProps {
  paused: boolean
  canPause: boolean
  onToggle: () => void
}

export function PracticePauseButton({
  paused,
  canPause,
  onToggle,
}: PracticePauseButtonProps) {
  const label = paused ? 'Resume practice round' : 'Pause practice round'
  return (
    <button
      type="button"
      className={`practice-pause${paused ? ' practice-pause--paused' : ''}`}
      aria-label={label}
      aria-pressed={paused}
      disabled={!canPause}
      onClick={onToggle}
    >
      {paused ? <Play size={17} aria-hidden="true" /> : <Pause size={17} aria-hidden="true" />}
      <span>{paused ? 'Resume' : 'Pause'}</span>
      <small>practice only</small>
    </button>
  )
}
