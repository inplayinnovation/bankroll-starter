import { BankrollBalances } from '@/components/bankroll-balances';
import { TabbedScreen } from '@/components/tabbed-screen';

// Build the app's surface here. Use an early return for gameplay or an
// individual result to give that screen the frame without the header or tabs.
export function Home() {
  return (
    <TabbedScreen
      header={
        <header className="flex justify-end">
          <BankrollBalances />
        </header>
      }
      tabs={[
        { id: 'play', label: 'Play', content: null },
        {
          id: 'results',
          label: 'Results',
          scroll: true,
          content: <p className="text-center text-sm text-neutral-500">No results yet.</p>,
        },
      ]}
    />
  );
}
