import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { MockHost } from '@/app/app/mock-host';

vi.mock('@/lib/treasury', () => ({ payeeAddress: () => 'Payee11111111111111111111111111111111111111' }));

afterEach(() => vi.unstubAllEnvs());

describe('MockHost', () => {
  it('puts the stand-in host on the page under BANKROLL_MOCK=1, unless a host is already there', () => {
    vi.stubEnv('BANKROLL_MOCK', '1');

    const markup = renderToStaticMarkup(<MockHost />);

    expect(markup).toContain('<script>');
    expect(markup).toContain('if (!window.bankroll) {');
    expect(markup).toContain('window.bankroll = {');
    expect(markup).toContain('Payee11111111111111111111111111111111111111');
  });

  it('renders nothing when the mock is off', () => {
    vi.stubEnv('BANKROLL_MOCK', '');

    expect(renderToStaticMarkup(<MockHost />)).toBe('');
  });
});
