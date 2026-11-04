/**
 * Client (docs/03-state-machines.md): onboarding -go_live-> live; live -pause-> paused -resume-> live;
 * live | paused -offboard-> offboarded. Go live happens only through O-10; offboarding through CL-11.
 * Paused (CL-08): syncing and eligibility keep running; releases and PM write-backs wait.
 */
import { transition, type TransitionTable } from './machine';

export type ClientState = 'onboarding' | 'live' | 'paused' | 'offboarded';
export type ClientEvent = 'go_live' | 'pause' | 'resume' | 'offboard';

const TABLE: TransitionTable<ClientState, ClientEvent> = {
  onboarding: { go_live: 'live' },
  live: { pause: 'paused', offboard: 'offboarded' },
  paused: { resume: 'live', offboard: 'offboarded' },
};

export const nextClientState = (from: ClientState, event: ClientEvent) => transition(TABLE, from, event);

/** CL-08 reasons (required). */
export const PAUSE_REASONS = [
  'Practice asked us to pause',
  'Contract or billing issue',
  'Setup problem to fix first',
  'Other',
] as const;
