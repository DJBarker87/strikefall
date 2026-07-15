import { Bot, Crosshair, Zap } from 'lucide-react'
import type { ResultStories, ResultStory } from '../product/resultStories'

export interface ResultStoryStripProps {
  stories: ResultStories
}

const ICONS = {
  skill: Crosshair,
  rival: Bot,
  lobby: Zap,
} as const

function Story({ story }: { story: ResultStory }) {
  const Icon = ICONS[story.kind]
  return (
    <article className={`result-story result-story--${story.kind}`}>
      <Icon size={16} aria-hidden="true" />
      <span>
        <small>{story.label}</small>
        <strong>{story.title}</strong>
        <span>{story.detail}</span>
      </span>
    </article>
  )
}

export function ResultStoryStrip({ stories }: ResultStoryStripProps) {
  return (
    <section className="result-stories" aria-label="Round stories">
      <Story story={stories.skill} />
      <Story story={stories.rival} />
      <Story story={stories.lobby} />
    </section>
  )
}
