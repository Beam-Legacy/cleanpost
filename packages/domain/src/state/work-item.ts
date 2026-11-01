/**
 * Work item lifecycle (docs/03-state-machines.md):
 * open -assign-> assigned -start-> in_progress -resolve-> resolved; open/assigned -snooze-> snoozed
 * -wake-> open; any -auto_resolve-> resolved (actor = automation); resolved -reopen-> open.
 */
import { transition, type TransitionTable } from './machine';

export type WorkItemState = 'open' | 'assigned' | 'in_progress' | 'snoozed' | 'resolved';
export type WorkItemEvent = 'assign' | 'start' | 'snooze' | 'wake' | 'resolve' | 'auto_resolve' | 'reopen';

const TABLE: TransitionTable<WorkItemState, WorkItemEvent> = {
  open: { assign: 'assigned', snooze: 'snoozed', resolve: 'resolved', auto_resolve: 'resolved' },
  assigned: {
    start: 'in_progress',
    snooze: 'snoozed',
    resolve: 'resolved',
    auto_resolve: 'resolved',
    assign: 'assigned',
  },
  in_progress: { resolve: 'resolved', auto_resolve: 'resolved', assign: 'in_progress' },
  snoozed: { wake: 'open', auto_resolve: 'resolved', resolve: 'resolved' },
  resolved: { reopen: 'open' },
};

export const nextWorkItemState = (from: WorkItemState, event: WorkItemEvent) =>
  transition(TABLE, from, event);

/** States that still need someone's attention. */
export const isOpenWorkItem = (s: WorkItemState) => s !== 'resolved';
