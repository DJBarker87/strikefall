import {
  Bot,
  CalendarDays,
  Check,
  FlagTriangleRight,
  Target,
  Trophy,
} from 'lucide-react'
import { useId, type CSSProperties } from 'react'
import type { WeeklyChallenge, WeeklyChallengeProgress } from './weeklyChallenge'
import './progression.css'

export interface WeeklyChallengeCardProps {
  challenge: WeeklyChallenge
  progress: WeeklyChallengeProgress
  onPlay?: (challenge: WeeklyChallenge) => void
  starting?: boolean
  disabled?: boolean
}

export interface WeeklyChallengeLaunchProps extends Omit<WeeklyChallengeCardProps, 'onPlay'> {
  onPlay: (challenge: WeeklyChallenge) => void
}

type WeeklyAccentStyle = CSSProperties & { '--weekly-accent': string }

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function friendlyWeek(challenge: WeeklyChallenge): string {
  const end = new Date(dateFromKey(challenge.weekEndExclusive).getTime() - 86_400_000)
  const format = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return `${format.format(dateFromKey(challenge.weekStart))}–${format.format(end)} UTC`
}

function attemptCopy(progress: WeeklyChallengeProgress): string {
  if (progress.completed) {
    return `Rivalry cleared in ${progress.attempts} ${progress.attempts === 1 ? 'attempt' : 'attempts'}.`
  }
  if (progress.attempts > 0) {
    return `${progress.attempts} ${progress.attempts === 1 ? 'attempt' : 'attempts'} logged · the next line is still unseen.`
  }
  return 'Ordinary lobby, featured deck, fresh unseen line every attempt.'
}

export function WeeklyChallengeCard({
  challenge,
  progress,
  onPlay,
  starting = false,
  disabled = false,
}: WeeklyChallengeCardProps) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <section
      className={`weekly-challenge weekly-challenge--${challenge.deck.id}`}
      style={{ '--weekly-accent': challenge.rival.color } as WeeklyAccentStyle}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-path-policy={challenge.pathPolicy}
      data-launch-policy={challenge.launchPolicy}
    >
      <header className="weekly-challenge__header">
        <span className="weekly-challenge__eyebrow">
          <CalendarDays size={14} aria-hidden="true" /> Weekly rivalry · {friendlyWeek(challenge)}
        </span>
        <span className={`weekly-challenge__status${progress.completed ? ' weekly-challenge__status--complete' : ''}`}>
          {progress.completed ? <Check size={13} aria-hidden="true" /> : <Target size={13} aria-hidden="true" />}
          {progress.completed ? 'Rival beaten' : 'Live target'}
        </span>
      </header>

      <div className="weekly-challenge__matchup">
        <span className="weekly-challenge__portrait" aria-hidden="true">
          <Bot size={25} />
          <i>BOT</i>
        </span>
        <span className="weekly-challenge__versus" aria-hidden="true">VS</span>
        <div>
          <small>{challenge.rival.persona} rival · {challenge.deck.name} v{challenge.deckVersion}</small>
          <h3 id={titleId}>{challenge.rival.name}</h3>
          <p>{challenge.deck.kicker}</p>
        </div>
      </div>

      <div className="weekly-challenge__mission">
        <Trophy size={19} aria-hidden="true" />
        <span>
          <small>This week’s mission</small>
          <strong>{challenge.mission.title}</strong>
          <span id={descriptionId}>{challenge.mission.description}</span>
          <code>{challenge.mission.rule}</code>
        </span>
      </div>

      <footer className="weekly-challenge__footer">
        <p>{attemptCopy(progress)}</p>
        {onPlay && (
          <button
            type="button"
            disabled={starting || disabled}
            aria-busy={starting}
            onClick={() => onPlay(challenge)}
          >
            <FlagTriangleRight size={16} aria-hidden="true" />
            {starting ? 'Seeding…' : progress.completed ? 'Challenge again' : 'Challenge rival'}
          </button>
        )}
      </footer>
    </section>
  )
}

/** Compact, keyboard-native home entry point for an ordinary featured-deck run. */
export function WeeklyChallengeLaunch({
  challenge,
  progress,
  onPlay,
  starting = false,
  disabled = false,
}: WeeklyChallengeLaunchProps) {
  return (
    <button
      className={`weekly-launch weekly-launch--${challenge.deck.id}`}
      style={{ '--weekly-accent': challenge.rival.color } as WeeklyAccentStyle}
      type="button"
      disabled={starting || disabled}
      aria-busy={starting}
      aria-label={`${progress.completed ? 'Replay' : 'Play'} weekly rivalry against ${challenge.rival.name} on ${challenge.deck.name}`}
      data-path-policy={challenge.pathPolicy}
      data-launch-policy={challenge.launchPolicy}
      onClick={() => onPlay(challenge)}
    >
      <span className="weekly-launch__icon" aria-hidden="true">
        {progress.completed ? <Check size={18} /> : <Bot size={19} />}
      </span>
      <span className="weekly-launch__copy">
        <small>{progress.completed ? 'Weekly cleared · fresh rematch' : 'Weekly bot rivalry'}</small>
        <strong>{challenge.rival.name} <i>· {challenge.rival.persona}</i></strong>
        <span>{challenge.deck.name} · {challenge.mission.rule}</span>
      </span>
      <span className="weekly-launch__action" aria-hidden="true">
        {starting ? 'Seeding…' : 'Challenge'} <FlagTriangleRight size={15} />
      </span>
    </button>
  )
}
