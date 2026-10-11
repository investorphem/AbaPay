import type { Metadata } from 'next';
import StatsView from './StatsView';

export const metadata: Metadata = {
  title: 'On-chain activity — AbaPay Rails',
  description: 'Every payment into an AbaPay vault on Celo, read directly from the chain: payments, wallets, volume and rails, each linked to its transaction.',
};

// Re-read the index at most every 5 minutes. It only gains rows every 15.
export const revalidate = 300;

export default function StatsPage() {
  return <StatsView chain="CELO" />;
}
