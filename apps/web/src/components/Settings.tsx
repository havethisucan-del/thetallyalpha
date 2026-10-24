import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { CARTIGNON_COLORS, COLOR_INFO } from '../match/cartignon/colors';
import {
  PALETTE_LABELS,
  PALETTE_SETTINGS,
  setPalette,
  swatchesFor,
  type PaletteSetting,
} from '../settings/palette';
import { usePalette, useThemePreference } from '../settings/useSettings';
import { setThemePreference, THEME_PREFERENCES, type ThemePreference } from '../theme/theme';
import { buttonClass, optionRowClass, radioMarkerClass } from './ui';

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const THEME_HINTS: Readonly<Record<ThemePreference, string>> = {
  system: 'Follows your device',
  light: 'Warm paper',
  dark: 'Night ink',
};

const PALETTE_HINTS: Readonly<Record<PaletteSetting, string>> = {
  normal: 'The original card colours',
  colorblind: 'Tuned for protanopia, deuteranopia and tritanopia',
};

/** The seven card colours of one palette, in rule order (decorative; the label names it). */
function PaletteStrip({ setting }: { setting: PaletteSetting }) {
  const swatches = swatchesFor(setting);
  return (
    <span
      className="flex flex-wrap gap-1"
      aria-hidden="true"
      data-testid={`palette-strip-${setting}`}
    >
      {CARTIGNON_COLORS.map((color) => (
        <span
          key={color}
          className="ink-line size-5 rounded-sm"
          style={{ backgroundColor: swatches[color].hex }}
          title={COLOR_INFO[color].label}
        />
      ))}
    </span>
  );
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Starts the tutorial (closing Settings first); omitted hides the button (e.g. in a match). */
  onReplayTutorial?: (() => void) | undefined;
  /** Gets focus on close when the opener is no longer visible (e.g. the table menu's toggle). */
  returnFocusRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Settings (theme, card colours, optionally Replay tutorial) on the native modal <dialog>:
 * showModal() traps focus and makes the page behind inert, Escape closes it, focus returns to
 * the element that opened it. Choices apply at once (no Save); each is persisted per viewer in
 * localStorage by its store (theme.ts, palette.ts) and works without storage for this page.
 */
export function SettingsDialog({
  open,
  onClose,
  onReplayTutorial,
  returnFocusRef,
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const themeName = useId();
  const paletteName = useId();
  const theme = useThemePreference();
  const palette = usePalette();

  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      // Back to the opener; if it is gone or hidden (a closed menu's item), to the fallback.
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener instanceof HTMLElement && opener.isConnected && opener.offsetParent !== null) {
        opener.focus();
      } else {
        returnFocusRef?.current?.focus();
      }
    }
  }, [open, returnFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={
        'ink-line m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto ' +
        'rounded-lg bg-paper-raised p-4 text-ink backdrop:bg-[rgb(22_18_13/0.6)] sm:p-5'
      }
      onCancel={(event) => {
        event.preventDefault(); // keep the dialog under React's control
        onClose();
      }}
      data-testid="settings-dialog"
    >
      <div className="ui-rule mb-4 flex items-center justify-between gap-3 pb-2">
        <h2 id={titleId} className="text-3xl leading-none">
          Settings
        </h2>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={onClose}
          data-testid="settings-close"
        >
          Done
        </button>
      </div>

      <div className="flex flex-col gap-5">
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-xl">Theme</legend>
          {THEME_PREFERENCES.map((value) => (
            <label key={value} className={optionRowClass}>
              <input
                type="radio"
                name={themeName}
                value={value}
                checked={theme === value}
                onChange={() => {
                  setThemePreference(value);
                }}
                className={radioMarkerClass}
                data-testid={`settings-theme-${value}`}
              />
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 leading-tight">
                <span className="text-xl">{THEME_LABELS[value]}</span>
                <span className="text-base text-ink-muted">{THEME_HINTS[value]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-xl">Card colours</legend>
          {PALETTE_SETTINGS.map((value) => (
            <label key={value} className={`${optionRowClass} items-start py-2`}>
              <input
                type="radio"
                name={paletteName}
                value={value}
                checked={palette === value}
                onChange={() => {
                  setPalette(value);
                }}
                className={`${radioMarkerClass} mt-0.5`}
                data-testid={`settings-palette-${value}`}
              />
              <span className="flex min-w-0 flex-col gap-1.5 leading-tight">
                <span className="text-xl">{PALETTE_LABELS[value]}</span>
                <span className="text-base text-ink-muted">{PALETTE_HINTS[value]}</span>
                <PaletteStrip setting={value} />
              </span>
            </label>
          ))}
        </fieldset>

        {onReplayTutorial && (
          <div className="flex flex-col gap-2">
            <h3 className="text-xl leading-none">Tutorial</h3>
            <button
              type="button"
              className={`${buttonClass.secondary} self-start`}
              onClick={() => {
                onClose();
                onReplayTutorial();
              }}
              data-testid="settings-replay-tutorial"
            >
              Replay tutorial
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

/** Gear icon (decorative). */
export function GearIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={className} focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8.6 1.5h2.8l.5 2.3c.5.2 1 .5 1.4.8l2.2-.8 1.4 2.4-1.8 1.6a6 6 0 0 1 0 1.6l1.8 1.6-1.4 2.4-2.2-.8c-.4.3-.9.6-1.4.8l-.5 2.3H8.6l-.5-2.3c-.5-.2-1-.5-1.4-.8l-2.2.8-1.4-2.4 1.8-1.6a6 6 0 0 1 0-1.6L3.1 6.2l1.4-2.4 2.2.8c.4-.3.9-.6 1.4-.8l.5-2.3ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      />
    </svg>
  );
}

/**
 * A "Settings" button that opens its own Settings dialog (page header). 44px target, visible
 * label next to the gear.
 */
export function SettingsButton({
  onReplayTutorial,
  className = '',
}: {
  onReplayTutorial?: (() => void) | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={
          'ink-line inline-flex min-h-target min-w-target shrink-0 items-center justify-center ' +
          'gap-1.5 rounded-md bg-paper-raised px-2.5 text-base leading-none text-ink ' +
          `transition-colors hover:bg-paper-sunken ${className}`
        }
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="settings-open"
      >
        <GearIcon />
        <span>Settings</span>
      </button>
      <SettingsDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        onReplayTutorial={onReplayTutorial}
      />
    </>
  );
}
