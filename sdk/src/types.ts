import type { Account } from "viem";

/**
 * Anything that can produce an EIP-712 signature — a viem `Account` from
 * `privateKeyToAccount`, a `WalletClient`'s account, or any object shaped the same way. The SDK
 * never asks for or touches a private key directly; it only ever calls `signTypedData`.
 *
 * Redeclared (not `Pick<Account, ...>`) because viem's own `Account.signTypedData` is
 * optional — some account types (JSON-RPC accounts with no local key) can't sign at all. Every
 * caller of this SDK's functions must pass one that genuinely can.
 */
export type Signer = Pick<Account, "address"> & {
  signTypedData: NonNullable<Account["signTypedData"]>;
};

export type ServiceCategory =
  | "AIRTIME"
  | "DATA"
  | "ELECTRICITY"
  | "CABLE"
  | "EDUCATION"
  | "BANK";

/** The same fields public/openapi.json's /api/pay/x402 requestBody documents. */
export interface BillDetails {
  serviceID: string;
  serviceCategory: ServiceCategory;
  network: string;
  billersCode: string;
  nairaAmount: number;
  /** Celo mainnet only — see the SDK's file-level comments for why. */
  token: "USDC" | "USDT";
  wallet_address: string;
}

export interface X402PayResult {
  success: boolean;
  status: "SUCCESS" | "FAILED_VENDING" | "TIMEOUT" | string;
  purchased_code?: string | null;
  units?: string | null;
  request_id?: string;
  tx_hash?: string;
  message?: string;
}

export class AbaPayError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = "AbaPayError";
  }
}
