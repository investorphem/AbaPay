import type { Metadata } from 'next';
import StatsView from '../StatsView';

export const metadata: Metadata = {
  title: 'On-chain activity on Base — AbaPay Rails',
  description: 'Every payment into an AbaPay vault on Base, read directly from the chain: payments, wallets, volume and rails, each linked to its transaction.',
};

export const revalidate = 300;

export default function BaseStatsPage() {
  return <StatsView chain="BASE" />;
}
