import { describe, it, expect, afterEach } from 'vitest';
import { celo, base, celoSepolia } from 'viem/chains';
import { rpcUrlsFor } from '@/lib/chain';

// Which RPC endpoints each chain uses: a private (paid, e.g. Chainstack) one first when the
// server has it, then the public ones as fallbacks.

const saved = { celo: process.env.CELO_RPC_URL, base: process.env.BASE_RPC_URL };
afterEach(() => {
  process.env.CELO_RPC_URL = saved.celo;
  process.env.BASE_RPC_URL = saved.base;
  if (saved.celo === undefined) delete process.env.CELO_RPC_URL;
  if (saved.base === undefined) delete process.env.BASE_RPC_URL;
});

describe('rpcUrlsFor', () => {
  it('uses only the public endpoints when no private RPC is set (and in the browser)', () => {
    delete process.env.CELO_RPC_URL;
    delete process.env.BASE_RPC_URL;
    expect(rpcUrlsFor(celo.id)).toEqual(['https://forno.celo.org', 'https://rpc.ankr.com/celo']);
    expect(rpcUrlsFor(base.id)[0]).toBe('https://mainnet.base.org');
  });

  it('puts the private RPC first and keeps every public one behind it as a fallback', () => {
    process.env.CELO_RPC_URL = ' https://celo-mainnet.core.chainstack.com/KEY ';
    process.env.BASE_RPC_URL = 'https://base-mainnet.core.chainstack.com/KEY';
    expect(rpcUrlsFor(celo.id)).toEqual(['https://celo-mainnet.core.chainstack.com/KEY', 'https://forno.celo.org', 'https://rpc.ankr.com/celo']);
    expect(rpcUrlsFor(base.id).slice(0, 2)).toEqual(['https://base-mainnet.core.chainstack.com/KEY', 'https://mainnet.base.org']);
  });

  it('never applies a mainnet key to a testnet', () => {
    process.env.CELO_RPC_URL = 'https://celo-mainnet.core.chainstack.com/KEY';
    expect(rpcUrlsFor(celoSepolia.id)).toEqual(['https://alfajores-forno.celo-testnet.org']);
  });

  it('ignores a blank value', () => {
    process.env.CELO_RPC_URL = '   ';
    expect(rpcUrlsFor(celo.id)[0]).toBe('https://forno.celo.org');
  });
});
