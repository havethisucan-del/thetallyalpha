import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeaveConfirmDialog } from '../src/match/LeaveConfirmDialog';
import { shouldConfirmLeave } from '../src/match/leaveConfirm';
import type { MatchSnapshot } from '../src/net/matchConnection';

type Input = Pick<MatchSnapshot, 'view' | 'room'>;

function snapshot(outcome: unknown, phase: string | null): Input {
  return {
    view: { outcome } as unknown as MatchSnapshot['view'],
    room: phase === null ? null : ({ phase } as unknown as MatchSnapshot['room']),
  };
}

describe('shouldConfirmLeave', () => {
  it('confirms while a match is in progress', () => {
    expect(shouldConfirmLeave(snapshot(null, 'active'))).toBe(true);
    expect(shouldConfirmLeave(snapshot(null, null))).toBe(true);
  });

  it('leaves in one click without a view, with an outcome, in the lobby or when finished', () => {
    expect(shouldConfirmLeave({ view: null, room: null })).toBe(false);
    expect(shouldConfirmLeave(snapshot({ result: 'draw' }, 'active'))).toBe(false);
    expect(shouldConfirmLeave(snapshot(null, 'finished'))).toBe(false);
    expect(shouldConfirmLeave(snapshot(null, 'lobby'))).toBe(false);
  });
});

describe('LeaveConfirmDialog markup', () => {
  const noop = () => undefined;
  const html = renderToStaticMarkup(
    createElement(LeaveConfirmDialog, { open: false, onLeave: noop, onStay: noop }),
  );

  it('is a labelled native dialog with the question', () => {
    expect(html).toMatch(/^<dialog[^>]*aria-labelledby="leave-confirm-title"/);
    expect(html).toContain('id="leave-confirm-title"');
    expect(html).toContain('Are you sure you want to leave the match?');
  });

  it('offers Stay before Leave, both as buttons', () => {
    const stay = html.indexOf('data-testid="leave-confirm-stay"');
    const leave = html.indexOf('data-testid="leave-confirm-leave"');
    expect(stay).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(stay);
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
  });
});
