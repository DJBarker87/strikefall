import { Component, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { reportClientRuntimeError } from '../runtimeErrors'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export class GameErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    reportClientRuntimeError({
      cause: error,
      code: 'render_failure',
    })
  }

  private recover = () => {
    this.setState({ failed: false })
    window.location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main className="fatal-state">
        <div className="fatal-state__card" role="alert">
          <span className="fatal-state__icon" aria-hidden="true">
            <TriangleAlert size={24} />
          </span>
          <p className="eyebrow">Arena interrupted</p>
          <h1>The line slipped its rails.</h1>
          <p>Your score was local to this run. Reload the arena to start with a fresh seed.</p>
          <button className="button button--primary" type="button" onClick={this.recover}>
            <RotateCcw size={18} aria-hidden="true" />
            Reload arena
          </button>
        </div>
      </main>
    )
  }
}
