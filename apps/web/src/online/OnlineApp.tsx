import type { RoomAdmission, SessionResponse } from '@cartignon/protocol';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { PageLayout, TableLayout } from '../components/AppLayout';
import { StatusBar } from '../components/StatusBar';
import { buttonClass } from '../components/ui';
import { gameServerUrl } from '../config';
import { useApiHealth } from '../hooks/useApiHealth';
import { ApiClient, ApiError, friendlyMessage } from '../lib/api';
import { clearActiveRoom, resumeActiveRoom, saveActiveRoom } from '../net/activeRoom';
import { MatchConnection } from '../net/matchConnection';
import { IDLE_SNAPSHOT, type MatchSnapshot } from '../net/matchSource';
import { LobbyScreen } from '../screens/LobbyScreen';
import { MatchScreen } from '../screens/MatchScreen';
import { OnlinePlaySection, type SessionState } from '../screens/OnlinePlaySection';

/**
 * ADR-0017: everything online (guest session, health polling, room resume, lobby, Colyseus) in one
 * lazily imported module, loaded only when `ONLINE_ENABLED`; the static build never includes it.
 */

/** What the menu screens show of the online part while no room is open. */
export interface OnlineParts {
  /** The online options for the Play screen. */
  section: ReactNode;
  /** Connection and server health, for the page header. */
  statusBar: ReactNode;
}

interface OnlineAppProps {
  /** Renders the menu screens (Home / Play / solo) while no online room is open. */
  children: (online: OnlineParts) => ReactNode;
  /** A solo match is running: a room resumed after a reload is not entered then. */
  soloActive: boolean;
  /** Called after leaving an online room (the menu then shows the Play screen). */
  onLeftRoom: () => void;
}

const noopSubscribe = () => () => undefined;
const idleSnapshot = (): MatchSnapshot => IDLE_SNAPSHOT;

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : friendlyMessage('INTERNAL');
}

export default function OnlineApp({ children, soloActive, onLeftRoom }: OnlineAppProps) {
  const api = useMemo(() => new ApiClient(), []);
  const health = useApiHealth(api);
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [connection, setConnection] = useState<MatchConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  // One in-flight session request at a time, so StrictMode's double effect cannot create two
  // guests.
  const sessionRequest = useRef<Promise<SessionResponse> | null>(null);
  const soloActiveRef = useRef(soloActive);
  soloActiveRef.current = soloActive;

  const snapshot = useSyncExternalStore(
    connection?.subscribe ?? noopSubscribe,
    connection?.getSnapshot ?? idleSnapshot,
  );

  const loadSession = useCallback(() => {
    setSession({ kind: 'loading' });
    sessionRequest.current ??= api.ensureSession().finally(() => {
      sessionRequest.current = null;
    });
    sessionRequest.current.then(
      (response) => {
        setSession({ kind: 'ready', player: response.player });
      },
      (error: unknown) => {
        setSession({ kind: 'error', message: errorMessage(error) });
      },
    );
  }, [api]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const openConnection = useCallback(
    (admission: RoomAdmission) => {
      saveActiveRoom(admission);
      const next = new MatchConnection(api, gameServerUrl());
      setConnection(next);
      void next.connect(admission);
    },
    [api],
  );

  // After a page reload, go back into the room this tab was in (the server keeps the seat).
  // Once per page load; the ref also keeps StrictMode's double effect from resuming twice.
  const resumeAttempted = useRef(false);
  useEffect(() => {
    if (session.kind !== 'ready' || resumeAttempted.current) return;
    resumeAttempted.current = true;
    setBusy(true);
    void resumeActiveRoom(api)
      .then((admission) => {
        if (admission && !soloActiveRef.current) openConnection(admission);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [api, session.kind, openConnection]);

  const enterRoom = useCallback(
    async (getAdmission: () => Promise<RoomAdmission>) => {
      setBusy(true);
      setHomeError(null);
      try {
        openConnection(await getAdmission());
      } catch (error) {
        setHomeError(errorMessage(error));
        if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') loadSession();
      } finally {
        setBusy(false);
      }
    },
    [loadSession, openConnection],
  );

  const goHome = useCallback(() => {
    clearActiveRoom();
    connection?.leave();
    setConnection(null);
    onLeftRoom();
  }, [connection, onLeftRoom]);

  const statusBar = <StatusBar status={snapshot.status} health={health} />;

  if (!connection) {
    return children({
      statusBar,
      section: (
        <OnlinePlaySection
          session={session}
          busy={busy}
          error={homeError}
          onRetrySession={loadSession}
          onCreate={() => void enterRoom(() => api.createPrivateRoom())}
          onJoin={(code) => void enterRoom(() => api.joinPrivateRoom(code))}
        />
      ),
    });
  }

  if (snapshot.view || (snapshot.room && snapshot.room.phase !== 'lobby')) {
    const screen = (
      <MatchScreen
        snapshot={snapshot}
        statusBar={statusBar}
        onIncrement={(amount) => connection.sendIncrement(amount)}
        onAction={(action) => connection.sendAction(action)}
        onHome={goHome}
      />
    );
    // A Cartignon match uses the full-viewport layout; other renderers keep the page layout.
    if (snapshot.cartignon !== null) return <TableLayout>{screen}</TableLayout>;
    return <PageLayout statusBar={statusBar}>{screen}</PageLayout>;
  }

  if (snapshot.status === 'disconnected' && !snapshot.room) {
    return (
      <PageLayout statusBar={statusBar}>
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-red-700 dark:text-red-300" data-testid="room-error">
            {snapshot.error ?? 'Disconnected from the room.'}
          </p>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={goHome}
            data-testid="back-home"
          >
            Back
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout statusBar={statusBar}>
      <LobbyScreen
        snapshot={snapshot}
        onReady={(ready) => {
          connection.setReady(ready);
        }}
        onLeave={goHome}
      />
    </PageLayout>
  );
}
