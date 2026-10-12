import type { Metadata } from 'next';
import StatsView from './StatsView';

export const metadata: Metadata = {
  title: { absolute: 'AbaPay Analytics — on-chain activity on Celo and Base' },
  description: 'Every payment into AbaPay’s vaults on Celo and Base, read directly from the chain: payments, wallets, volume and rails, each linked to its transaction.',
  alternates: { canonical: 'https://stats.abapays.com/' },
};

// Re-read the index at most every 5 minutes. It only gains rows every 15.
export const revalidate = 300;

export default function StatsOverviewPage() {
  return <StatsView chain={null} />;
}
