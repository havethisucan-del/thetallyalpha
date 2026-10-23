import type { ConnectionStatus } from '../net/matchSource';
import type { ApiHealth } from '../hooks/useApiHealth';

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Not in a room',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

const CONNECTION_DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-ink-muted',
  connecting: 'bg-warn',
  connected: 'bg-ahead',
  reconnecting: 'bg-warn',
  disconnected: 'bg-rubric',
};

const HEALTH_LABEL: Record<ApiHealth, string> = {
  checking: 'Checking…',
  ok: 'OK',
  unavailable: 'Unavailable',
};

const HEALTH_DOT: Record<ApiHealth, string> = {
  checking: 'bg-ink-muted',
  ok: 'bg-ahead',
  unavailable: 'bg-rubric',
};

function Dot({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${className}`} />;
}

export function StatusBar({ status, health }: { status: ConnectionStatus; health: ApiHealth }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted"
      aria-label="Connection status"
      role="group"
    >
      <span
        className="inline-flex items-center gap-1.5"
        role="status"
        data-testid="connection-status"
        data-status={status}
      >
        <Dot className={CONNECTION_DOT[status]} />
        Game: {CONNECTION_LABEL[status]}
      </span>
      <span
        className="inline-flex items-center gap-1.5"
        data-testid="api-health"
        data-status={health}
      >
        <Dot className={HEALTH_DOT[health]} />
        API: {HEALTH_LABEL[health]}
      </span>
    </div>
  );
}
