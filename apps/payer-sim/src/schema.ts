/** payer-sim's own schema, apart from Cleanpost's and pm-mock's. Synthetic claims only. */
import { bigint, index, integer, jsonb, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const sim = pgSchema('payer_sim');

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/** One row: how far the simulated clock is ahead of real time (POST /clock/advance). */
export const clock = sim.table('clock', {
  id: integer('id').primaryKey(),
  offsetMs: bigint('offset_ms', { mode: 'number' }).notNull().default(0),
});

/**
 * Each claim a submitter sent. The 277CA decision is made at intake and becomes visible when the
 * simulated clock passes ack_due_at (1 to 30 minutes later, docs/12-testing.md).
 */
export const submissions = sim.table(
  'submissions',
  {
    /** `${source}:${patientControlNumber}`: a resubmission replaces the earlier one. */
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    patientControlNumber: text('patient_control_number').notNull(),
    payerName: text('payer_name').notNull(),
    claim: jsonb('claim').notNull(),
    receivedAt: ts('received_at').notNull(),
    ackDueAt: ts('ack_due_at').notNull(),
    /** accepted | rejected */
    ackStatus: text('ack_status').notNull(),
    /** 277CA category:status pairs, e.g. "A2:20", "A7:33". */
    ackCodes: text('ack_codes').array().notNull(),
    ackReasons: text('ack_reasons').array().notNull(),
  },
  (t) => [index('submissions_source_due_idx').on(t.source, t.ackDueAt)],
);

/**
 * The payer's member file (its enrollment), loaded by pm-mock's seed: who is covered, when, and
 * their cost sharing. Matched on payer, member ID and date of birth, as a 270 is.
 */
export const members = sim.table(
  'members',
  {
    payerId: text('payer_id').notNull(),
    memberId: text('member_id').notNull(),
    dateOfBirth: text('date_of_birth').notNull(),
    /** active | inactive */
    status: text('status').notNull(),
    planBegin: text('plan_begin'),
    planEnd: text('plan_end'),
    copayCents: integer('copay_cents'),
    deductibleRemainingCents: integer('deductible_remaining_cents'),
    coinsurancePercent: integer('coinsurance_percent'),
  },
  (t) => [primaryKey({ columns: [t.payerId, t.memberId] })],
);
