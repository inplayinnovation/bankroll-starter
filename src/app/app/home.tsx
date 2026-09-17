import { BankrollBalances } from '@/components/bankroll-balances';

// Build the app's surface here. It owns the header so gameplay can hide it.
// page.tsx supplies the entry gates; layout.tsx supplies safe-area padding.
export function Home() {
  return (
    <header className="flex justify-end">
      <BankrollBalances />
    </header>
  );
}
