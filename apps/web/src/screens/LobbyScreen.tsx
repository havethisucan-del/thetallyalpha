import { useEffect, useState } from 'react';
import { alertClass, buttonClass, cardClass } from '../components/ui';
import { clipboardWriter } from '../lib/secureContext';
import type { MatchSnapshot } from '../net/matchSource';

interface LobbyScreenProps {
  snapshot: MatchSnapshot;
  onReady: (ready: boolean) => void;
  onLeave: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function LobbyScreen({ snapshot, onReady, onLeave }: LobbyScreenProps) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const code = snapshot.room?.code || snapshot.inviteCode || '';
  const mySeat = snapshot.seat;
  const me = mySeat === null ? null : (snapshot.room?.seats[mySeat] ?? null);
  const canAct = snapshot.status === 'connected' && me !== null;

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => {
      setCopy('idle');
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copy]);

  // Missing outside secure contexts (plain-http LAN play, ADR-0013): no button, copy by hand.
  const writeClipboard = clipboardWriter();

  const copyCode = () => {
    if (writeClipboard === null) return;
    writeClipboard(code).then(
      () => {
        setCopy('copied');
      },
      () => {
        setCopy('failed');
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <section className={cardClass} aria-labelledby="invite-heading">
        <h2 id="invite-heading" className="text-base font-semibold">
          Invite code
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Share this code with your opponent.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <output
            className="text-5xl leading-none tracking-[0.3em] select-all"
            data-testid="invite-code"
            aria-label={`Invite code ${code.split('').join(' ')}`}
          >
            {code || '——————'}
          </output>
          {writeClipboard !== null ? (
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={copyCode}
                disabled={!code}
                data-testid="copy-invite-code"
              >
                Copy code
              </button>
              <span role="status" className="text-sm text-ink-muted">
                {copy === 'copied'
                  ? 'Copied!'
                  : copy === 'failed'
                    ? 'Copy failed — select the code.'
                    : ''}
              </span>
            </>
          ) : (
            <span className="text-sm text-ink-muted" data-testid="copy-manual">
              Select the code to copy it.
            </span>
          )}
        </div>
      </section>

      {snapshot.error && (
        <p role="alert" className={alertClass} data-testid="room-error">
          {snapshot.error}
        </p>
      )}

      <section className={cardClass} aria-labelledby="seats-heading">
        <h2 id="seats-heading" className="mb-3 text-base font-semibold">
          Players
        </h2>
        <ul className="flex flex-col gap-2">
          {([0, 1] as const).map((seat) => {
            const player = snapshot.room?.seats[seat] ?? null;
            const isMe = seat === mySeat;
            return (
              <li
                key={seat}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
                  isMe ? 'border-turn border-l-[6px] bg-paper-sunken' : 'border-line bg-paper'
                }`}
                data-testid={`seat-${seat}`}
                data-me={isMe ? 'true' : 'false'}
              >
                <span className="font-medium">
                  {player ? player.displayName : 'Waiting for opponent…'}
                  {isMe && <span className="ml-2 text-xs font-semibold uppercase">(you)</span>}
                </span>
                {player && (
                  <span className="flex gap-3 text-sm">
                    <span data-testid={`seat-${seat}-ready`}>
                      {player.ready ? 'Ready' : 'Not ready'}
                    </span>
                    <span data-testid={`seat-${seat}-connected`}>
                      {player.connected ? 'Online' : 'Offline'}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p
          className="mt-3 text-sm text-ink-muted"
          data-testid="phase"
          data-phase={snapshot.room?.phase ?? 'unknown'}
        >
          {snapshot.room ? 'Waiting for both players to be ready.' : 'Joining room…'}
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={buttonClass.primary}
          data-ready={me?.ready ? 'true' : 'false'}
          disabled={!canAct}
          onClick={() => {
            onReady(!(me?.ready ?? false));
          }}
          data-testid="ready-toggle"
        >
          {me?.ready ? 'Not ready' : 'Ready'}
        </button>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={onLeave}
          data-testid="leave-room"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
