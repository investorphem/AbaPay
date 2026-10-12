import type { Metadata } from 'next';
import StatsView from '../StatsView';

export const metadata: Metadata = {
  title: 'Celo',
  description: 'Every payment into AbaPay’s vaults on Celo, read directly from the chain: payments, wallets, volume and rails, each linked to its transaction.',
  alternates: { canonical: 'https://stats.abapays.com/celo' },
};

export const revalidate = 300;

export default function CeloStatsPage() {
  return <StatsView chain="CELO" />;
}
