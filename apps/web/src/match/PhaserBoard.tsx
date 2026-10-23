import { useEffect, useRef, useState } from 'react';
import type { BoardHandle, BoardModel } from './board';

/**
 * Mounts the Phaser canvas. Phaser is loaded lazily so the home and lobby screens do not pay for
 * it. The game is destroyed on unmount (also under React StrictMode's double mount).
 */
export function PhaserBoard({ model, summary }: { model: BoardModel; summary: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<BoardHandle | null>(null);
  const modelRef = useRef(model);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    modelRef.current = model;
    handleRef.current?.update(model);
  }, [model]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let handle: BoardHandle | null = null;

    import('./board').then(
      ({ createBoard }) => {
        if (cancelled) return;
        handle = createBoard(container);
        handle.update(modelRef.current);
        handleRef.current = handle;
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );

    return () => {
      cancelled = true;
      handle?.destroy();
      handleRef.current = null;
    };
  }, []);

  return (
    <div>
      <div
        ref={containerRef}
        role="img"
        aria-label={summary}
        className="w-full overflow-hidden rounded-lg bg-slate-900"
        data-testid="match-canvas"
      />
      {loadError && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">The board could not load.</p>
      )}
    </div>
  );
}
