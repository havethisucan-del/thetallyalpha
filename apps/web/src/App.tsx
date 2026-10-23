import type { BotLevel } from '@cartignon/ai';
import { lazy, Suspense, useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PageLayout, TableLayout } from './components/AppLayout';
import type { OnlineParts } from './online/OnlineApp';
import { HomeScreen } from './screens/HomeScreen';
import { MatchScreen } from './screens/MatchScreen';
import { PlayScreen } from './screens/PlayScreen';
import type { MatchSource } from './net/matchSource';
import { botLabel, LocalMatch } from './solo/localMatch';
import { applyStoredTheme } from './theme/theme';
import {
  markTutorial,
  shouldAutoStartTutorial,
  type TutorialProgressStatus,
} from './tutorial/progress';
import { TutorialMatch } from './tutorial/tutorialMatch';
import { TutorialOverlay } from './tutorial/TutorialOverlay';
// Jaini is the UI font everywhere (index.css --font-sans), not only on the card faces.
import '@fontsource/jaini/latin-400.css';

// The stored light/dark choice is on <html> before the first render.
applyStoredTheme();

/**
 * ADR-0017: the online part is a separate chunk, imported only when online play is enabled. The
 * condition is spelled out here (same as `ONLINE_ENABLED`) because the bundler only drops the
 * dynamic import, and with it the API client and the Colyseus SDK, when the test is a literal
 * `import.meta.env.MODE` comparison in this module; a constant imported from config.ts is not
 * folded. menuScreens.render.test.ts checks the two agree.
 */
const OnlineApp =
  import.meta.env.MODE !== 'static' ? lazy(() => import('./online/OnlineApp')) : null;

type MenuScreen = 'home' | 'play';

/** The online section while its chunk loads (the bot option never waits for it). */
const LOADING_ONLINE: OnlineParts = {
  section: <p className="text-ink-muted">Loading online play…</p>,
  statusBar: null,
};

/** A client-side match on the normal table: a bot match or the tutorial (ADR-0018). */
type SoloMatch =
  | { readonly kind: 'bot'; readonly match: LocalMatch }
  | { readonly kind: 'tutorial'; readonly match: TutorialMatch };

const TUTORIAL_OPPONENT_LABEL = 'Bot · Tutorial';

/** Any local MatchSource on the table, with an optional overlay above it (the tutorial coach). */
function SoloMatchScreen({
  source,
  opponentLabel,
  onHome,
  overlay = null,
  hideOutcome = false,
}: {
  source: MatchSource;
  opponentLabel: string;
  onHome: () => void;
  overlay?: ReactNode;
  hideOutcome?: boolean;
}) {
  // MatchSource does not promise bound methods; stable wrappers per source.
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const getSnapshot = useCallback(() => source.getSnapshot(), [source]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <TableLayout>
      <MatchScreen
        snapshot={snapshot}
        opponentLabel={opponentLabel}
        hideOutcome={hideOutcome}
        onIncrement={(amount) => source.sendIncrement(amount)}
        onAction={(action) => source.sendAction(action)}
        onHome={onHome}
      />
      {overlay}
    </TableLayout>
  );
}

/**
 * The tutorial on the table. While the coach runs on script (and after its last step) the table's
 * own outcome card is held back: the coach's goal steps narrate the 4-3 match end and its Finish
 * button leads out. Off script (free play) the outcome card shows as in a bot match.
 */
function TutorialMatchScreen({
  tutorial,
  onDone,
}: {
  tutorial: TutorialMatch;
  onDone: (status: TutorialProgressStatus) => void;
}) {
  const state = useSyncExternalStore(tutorial.subscribe, tutorial.getTutorialState);
  const coaching = state.status === 'finished' || (state.status === 'running' && !state.offScript);
  return (
    <SoloMatchScreen
      source={tutorial}
      opponentLabel={TUTORIAL_OPPONENT_LABEL}
      hideOutcome={coaching}
      // Leaving the table (Leave, or the outcome card off script) ends the tutorial too; it then
      // counts as skipped unless the match was played to its end.
      onHome={() => {
        onDone(tutorial.getSnapshot().view?.outcome ? 'completed' : 'skipped');
      }}
      overlay={
        <TutorialOverlay
          tutorial={tutorial}
          onSkip={() => {
            onDone('skipped');
          }}
          onFinish={() => {
            onDone('completed');
          }}
        />
      }
    />
  );
}

/** Whether this build includes online play (the lazy online chunk). */
export const APP_ONLINE = OnlineApp !== null;

export function App() {
  const [menu, setMenu] = useState<MenuScreen>('home');
  const [level, setLevel] = useState<BotLevel>(1);
  const [solo, setSolo] = useState<SoloMatch | null>(null);

  const leaveSolo = useCallback(() => {
    solo?.match.leave();
    setSolo(null);
    setMenu('home');
  }, [solo]);

  const showPlay = useCallback(() => {
    setMenu('play');
  }, []);

  const startTutorial = useCallback(() => {
    setSolo({ kind: 'tutorial', match: new TutorialMatch() });
  }, []);

  /** ADR-0018: the first Play click opens the tutorial until it was completed or skipped. */
  const onMenuPlay = useCallback(() => {
    if (shouldAutoStartTutorial()) startTutorial();
    else showPlay();
  }, [startTutorial, showPlay]);

  /** Finish or skip: record it, leave the tutorial match, then the bot picker. */
  const endTutorial = useCallback(
    (status: TutorialProgressStatus) => {
      markTutorial(status);
      solo?.match.leave();
      setSolo(null);
      setMenu('play');
    },
    [solo],
  );

  const renderMenu = (online: OnlineParts | null): ReactNode => {
    if (solo?.kind === 'tutorial') {
      return <TutorialMatchScreen tutorial={solo.match} onDone={endTutorial} />;
    }
    if (solo) {
      return (
        <SoloMatchScreen
          source={solo.match}
          opponentLabel={botLabel(solo.match.level)}
          onHome={leaveSolo}
        />
      );
    }
    if (menu === 'home') {
      return <HomeScreen items={[{ id: 'play', label: 'Play', onSelect: onMenuPlay }]} />;
    }
    return (
      <PageLayout statusBar={online?.statusBar}>
        <PlayScreen
          level={level}
          onLevelChange={setLevel}
          onPlayBot={() => {
            setSolo({ kind: 'bot', match: new LocalMatch({ level }) });
          }}
          onBack={() => {
            setMenu('home');
          }}
          onReplayTutorial={startTutorial}
          online={online?.section ?? null}
        />
      </PageLayout>
    );
  };

  if (!OnlineApp) return renderMenu(null);
  return (
    <Suspense fallback={renderMenu(LOADING_ONLINE)}>
      <OnlineApp soloActive={solo !== null} onLeftRoom={showPlay}>
        {renderMenu}
      </OnlineApp>
    </Suspense>
  );
}
