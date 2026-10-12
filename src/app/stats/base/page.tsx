import type { Metadata } from 'next';
import StatsView from '../StatsView';

export const metadata: Metadata = {
  title: 'Base',
  description: 'Every payment into AbaPay’s vaults on Base, read directly from the chain: payments, wallets, volume and rails, each linked to its transaction.',
  alternates: { canonical: 'https://stats.abapays.com/base' },
};

export const revalidate = 300;

export default function BaseStatsPage() {
  return <StatsView chain="BASE" />;
}
