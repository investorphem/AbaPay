import { permanentRedirect } from 'next/navigation';
import { statsHref } from '@/lib/onchain/statsUrl';

// The analytics moved to their own site, stats.abapays.com. Old links keep working.
export default function AgentsBaseStatsRedirect() {
  permanentRedirect(statsHref('/base'));
}
