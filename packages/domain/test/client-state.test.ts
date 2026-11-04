import { describe, expect, it } from 'vitest';
import { readBaseline, state, vsBaseline } from '../src';

describe('client state machine (docs/03)', () => {
  it('goes live once, pauses and resumes, and offboards from live or paused', () => {
    expect(state.nextClientState('onboarding', 'go_live')).toEqual({ ok: true, value: 'live' });
    expect(state.nextClientState('live', 'pause')).toEqual({ ok: true, value: 'paused' });
    expect(state.nextClientState('paused', 'resume')).toEqual({ ok: true, value: 'live' });
    expect(state.nextClientState('paused', 'offboard')).toEqual({ ok: true, value: 'offboarded' });
    expect(state.nextClientState('onboarding', 'pause').ok).toBe(false);
    expect(state.nextClientState('live', 'go_live').ok).toBe(false);
    expect(state.nextClientState('offboarded', 'resume').ok).toBe(false);
  });
});

describe('onboarding baseline (CL-02)', () => {
  const b = readBaseline({
    collectionsCents: 10_000_000,
    firstPass: 89,
    denialRate: 9.8,
    daysInAr: 38,
    source: 'Practice PM reports',
    recordedAt: '2026-11-04T17:00:00Z',
    recordedBy: 'user:x',
  });

  it('compares collections as a change and rates as the baseline, toned by the better direction', () => {
    expect(vsBaseline('collections', 11_100_000, b)).toEqual({
      text: '+11% vs baseline month',
      tone: 'good',
    });
    expect(vsBaseline('firstPass', 97.1, b)).toEqual({ text: 'Baseline 89.0%', tone: 'good' });
    expect(vsBaseline('denialRate', 12, b)).toEqual({ text: 'Baseline 9.8%', tone: 'bad' });
    expect(vsBaseline('daysInAr', 24, b)).toEqual({ text: 'Baseline 38', tone: 'good' });
    expect(vsBaseline('firstPass', null, b)).toEqual({ text: 'Baseline 89.0%', tone: 'neutral' });
  });

  it('shows nothing without a baseline or a figure for that metric', () => {
    expect(vsBaseline('firstPass', 97, null)).toBeNull();
    expect(vsBaseline('daysInAr', 24, { ...b!, daysInAr: null })).toBeNull();
    expect(readBaseline({ firstPass: 'high' })).toBeNull();
  });
});
