import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './button';
import { BalanceBar, Banner, Callout, ConfidenceMeter, FindingRow, Suggestion } from './notice';

const meta: Meta = { title: 'Base/Notices' };
export default meta;

export const Banners: StoryObj = {
  render: () => (
    <div className="stack">
      <Banner>Stedi is slow to respond; acknowledgments may arrive late.</Banner>
      <Banner tone="warn" action={<Button size="sm">Open connection</Button>}>
        Claim status has failed since 11:00 am.
      </Banner>
      <Banner tone="bad">Tebra rejected the saved login.</Banner>
      <Banner tone="good">All lines match.</Banner>
      <Callout>No blocking issues. Cleanpost releases this claim for tonight's 6:00 pm batch.</Callout>
    </div>
  ),
};

export const ClaimReview: StoryObj = {
  render: () => (
    <div className="stack" style={{ maxWidth: 480 }}>
      <ConfidenceMeter score={72} threshold={90} />
      <ConfidenceMeter score={94} threshold={90} />
      <Suggestion evidence={'Rule "UHC E/M with same-day procedure": 31 hits, 0 overrides in 90 days.'}>
        Visit billed with a same-day minor procedure. UnitedHealthcare requires modifier 25 on the visit line.
      </Suggestion>
      <FindingRow
        severity="warn"
        title="Add modifier 25 to line 1 (99213)"
        meta="Payer rule · −15"
        action={<Button size="sm">Apply fix</Button>}
      />
      <FindingRow severity="block" title="Diagnosis pointer 3 has no diagnosis" meta="Structural" />
      <FindingRow
        severity="info"
        title="First claim for this client and payer in 60 days"
        meta="History · −20"
      />
      <BalanceBar balanced label="835 balances">
        Payment $6,482.37 = claims paid $6,470.17 + interest $12.20
      </BalanceBar>
      <BalanceBar balanced={false} label="835 does not balance">
        Difference $22.20
      </BalanceBar>
    </div>
  ),
};
