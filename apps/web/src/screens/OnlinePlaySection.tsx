import { INVITE_CODE_LENGTH, type Player } from '@cartignon/protocol';
import { useId, useState, type SubmitEvent } from 'react';
import { alertClass, buttonClass, cardClass, inputClass } from '../components/ui';
import { isValidInviteCode, normalizeInviteCodeInput } from '../lib/inviteCode';

export type SessionState =
  { kind: 'loading' } | { kind: 'ready'; player: Player } | { kind: 'error'; message: string };

interface OnlinePlaySectionProps {
  session: SessionState;
  busy: boolean;
  error: string | null;
  onRetrySession: () => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
}

/**
 * Online play options (guest session, private rooms, casual queue), shown on the Play screen when
 * online play is enabled (ADR-0017). Formerly the whole Home screen.
 */
export function OnlinePlaySection({
  session,
  busy,
  error,
  onRetrySession,
  onCreate,
  onJoin,
}: OnlinePlaySectionProps) {
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  if (session.kind === 'loading') {
    return <p className="text-ink-muted">Starting guest session…</p>;
  }
  if (session.kind === 'error') {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className={alertClass} data-testid="session-error">
          {session.message}
        </p>
        <button type="button" className={buttonClass.secondary} onClick={onRetrySession}>
          Try again
        </button>
      </div>
    );
  }

  const submitJoin = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValidInviteCode(code)) {
      setCodeError(`Enter the ${INVITE_CODE_LENGTH}-character invite code.`);
      return;
    }
    setCodeError(null);
    onJoin(code);
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-lg">
        Playing as{' '}
        <strong className="font-semibold" data-testid="guest-name">
          {session.player.displayName}
        </strong>
      </p>

      {error && (
        <p role="alert" className={alertClass} data-testid="home-error">
          {error}
        </p>
      )}

      <section className={cardClass} aria-labelledby="create-heading">
        <h3 id="create-heading" className="mb-3 text-base font-semibold">
          Play with a friend
        </h3>
        <button
          type="button"
          className={buttonClass.primary}
          onClick={onCreate}
          disabled={busy}
          data-testid="create-room"
        >
          Create private room
        </button>
      </section>

      <section className={cardClass} aria-labelledby="join-heading">
        <h3 id="join-heading" className="mb-3 text-base font-semibold">
          Join with an invite code
        </h3>
        <form className="flex flex-col gap-2" onSubmit={submitJoin} noValidate>
          <label htmlFor={inputId} className="text-sm font-medium">
            Invite code
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={inputId}
              className={`${inputClass} sm:max-w-48`}
              value={code}
              onChange={(event) => {
                setCode(normalizeInviteCodeInput(event.target.value));
                setCodeError(null);
              }}
              maxLength={INVITE_CODE_LENGTH}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABC234"
              aria-describedby={codeError ? `${hintId} ${errorId}` : hintId}
              aria-invalid={codeError ? true : undefined}
              data-testid="join-code-input"
            />
            <button
              type="submit"
              className={buttonClass.secondary}
              disabled={busy}
              data-testid="join-room"
            >
              Join
            </button>
          </div>
          <p id={hintId} className="text-xs text-ink-muted">
            {INVITE_CODE_LENGTH} letters or digits, as shared by your friend.
          </p>
          {codeError && (
            <p id={errorId} className="text-sm text-rubric" role="alert">
              {codeError}
            </p>
          )}
        </form>
      </section>

      <section className={cardClass} aria-labelledby="queue-heading">
        <h3 id="queue-heading" className="mb-3 text-base font-semibold">
          Casual queue
        </h3>
        <button type="button" className={buttonClass.secondary} disabled data-testid="casual-queue">
          Casual queue — coming soon
        </button>
      </section>
    </div>
  );
}
