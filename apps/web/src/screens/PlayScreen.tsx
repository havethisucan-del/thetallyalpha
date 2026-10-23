import { BOT_LEVEL_NAMES, BOT_LEVELS, type BotLevel } from '@cartignon/ai';
import { useId, type ReactNode } from 'react';
import { buttonClass, cardClass } from '../components/ui';

interface PlayScreenProps {
  level: BotLevel;
  onLevelChange: (level: BotLevel) => void;
  onPlayBot: () => void;
  onBack: () => void;
  /** Online options (only when online play is enabled); null hides the online part. */
  online: ReactNode;
  /** Starts the tutorial again (ADR-0018 "Replay tutorial"); omitted hides the button. */
  onReplayTutorial?: () => void;
}

/** Play options: a solo match vs a bot (always available) and, when enabled, online play. */
export function PlayScreen({
  level,
  onLevelChange,
  onPlayBot,
  onBack,
  online,
  onReplayTutorial,
}: PlayScreenProps) {
  const botHeadingId = useId();
  const levelName = useId();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-3xl leading-none">Play</h2>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={onBack}
          data-testid="play-back"
        >
          Back
        </button>
      </div>

      <section className={cardClass} aria-labelledby={botHeadingId}>
        <h3 id={botHeadingId} className="mb-3 text-2xl leading-none">
          vs Bot
        </h3>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-lg text-ink-muted">Bot level</legend>
          {/* Manuscript option rows: ink-lined paper slips; the checked one is filled, gets a
              turn-coloured margin bar and a filled marker (never colour alone). */}
          <ul className="flex flex-col gap-2" data-testid="bot-levels">
            {BOT_LEVELS.map((value) => (
              <li key={value}>
                <label
                  className={
                    'ink-line flex min-h-12 cursor-pointer items-center gap-3 rounded-md ' +
                    'bg-paper py-1.5 pr-3 pl-4 transition-colors hover:bg-paper-sunken ' +
                    'has-checked:border-l-[6px] has-checked:border-l-turn has-checked:bg-paper-sunken ' +
                    'has-checked:pl-3 ' +
                    'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 ' +
                    'has-focus-visible:outline-focus'
                  }
                >
                  <input
                    type="radio"
                    name={levelName}
                    value={value}
                    checked={value === level}
                    onChange={() => {
                      onLevelChange(value);
                    }}
                    // Custom marker: ink ring; checked = turn fill inside a paper gap. The label
                    // carries the focus ring, so the input's own outline is not needed.
                    className={
                      'size-5 shrink-0 cursor-pointer appearance-none rounded-full border-2 ' +
                      'border-ink bg-paper-raised checked:border-turn checked:bg-turn ' +
                      'checked:shadow-[inset_0_0_0_3px_var(--color-paper-raised)] focus-visible:outline-none'
                    }
                    data-testid={`bot-level-${value}`}
                  />
                  <span className="min-w-0 text-xl leading-tight">
                    <span className="mr-1 text-rubric">L{value}</span> {BOT_LEVEL_NAMES[value]}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            className={`${buttonClass.primary} w-full sm:w-auto`}
            onClick={onPlayBot}
            data-testid="play-bot"
          >
            Play vs L{level} {BOT_LEVEL_NAMES[level]}
          </button>
          {onReplayTutorial && (
            <button
              type="button"
              className={`${buttonClass.secondary} w-full sm:w-auto`}
              onClick={onReplayTutorial}
              data-testid="play-tutorial"
            >
              Replay tutorial
            </button>
          )}
        </div>
      </section>

      {online}
    </div>
  );
}
