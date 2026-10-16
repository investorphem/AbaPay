"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { PayerIdentity } from "@/lib/payerIdentityTypes";

// 🤖 Which agent paid — the admin ledger's view of src/lib/payerIdentity.ts. Admin-only: the data
// comes from /api/admin/data. On-chain facts (ERC-8004, Self Agent ID) are shown as facts; what
// the request said about itself (User-Agent, declared name/id) is labelled as a claim.

export interface PaymentClientInfo {
  transaction_id: string;
  user_agent: string | null;
  declared_agent: string | null;
  declared_agent_id: string | null;
  client_diag: unknown;
}

function selfLabel(id: PayerIdentity) {
  if (id.self_verified === null) return { text: "Self ?", cls: "bg-slate-800 text-slate-400", title: "The Self Agent ID registry couldn't be read" };
  if (!id.self_verified) return { text: "Self ✗", cls: "bg-slate-800 text-slate-400", title: "Not a Self Agent ID (no proof-of-human registration)" };
  if (id.self_proof_fresh === false) return { text: "Self ⚠ stale", cls: "bg-orange-500/10 text-orange-400", title: "Self-verified, but the proof has expired" };
  return { text: "Self ✓", cls: "bg-emerald-500/10 text-emerald-400", title: `Self Agent ID #${id.self_agent_id ?? "?"} — bound to a human by a ZK passport proof` };
}

export function AdminPayerIdentity({ identity, client }: { identity?: PayerIdentity; client?: PaymentClientInfo }) {
  const [open, setOpen] = useState(false);
  if (!identity && !client) {
    return <p className="text-[9px] text-slate-600 italic mt-1">Agent: not looked up yet</p>;
  }
  const agents = identity?.erc8004_agents ?? [];
  const primary = agents[0];
  const self = identity ? selfLabel(identity) : null;
  const claimedName = client?.declared_agent;

  return (
    <div className="mt-1.5 max-w-[240px]">
      <button onClick={() => setOpen((o) => !o)} className="flex flex-wrap items-center gap-1 text-left">
        <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">
          🤖 {primary ? `${primary.name || "Unnamed agent"} #${primary.id}` : claimedName ? `“${claimedName}” (claimed)` : "No ERC-8004 identity"}
        </span>
        {self && <span title={self.title} className={`text-[9px] font-black px-1.5 py-0.5 rounded ${self.cls}`}>{self.text}</span>}
        {agents.length > 1 && <span className="text-[9px] text-slate-500">+{agents.length - 1}</span>}
      </button>

      {open && (
        <div className="mt-1.5 p-2 rounded-lg bg-slate-950 border border-slate-800 text-[9px] text-slate-400 space-y-1.5">
          {agents.map((a) => (
            <div key={a.id}>
              <p className="text-slate-200 font-bold">
                ERC-8004 #{a.id} · {a.name || "unnamed"} <span className="text-slate-500 font-normal">({a.relation === "owner" ? "wallet owns it" : "registry names this wallet as its agent wallet"}{a.active === false ? ", inactive" : ""})</span>
              </p>
              {a.description && <p className="leading-snug">{a.description}</p>}
              <div className="flex flex-wrap gap-2">
                <a href={`https://8004scan.io/agents/celo/${a.id}`} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline inline-flex items-center gap-0.5">8004scan <ExternalLink size={8} /></a>
                {a.web && <a href={a.web} target="_blank" rel="noopener noreferrer nofollow" className="text-emerald-400 hover:underline inline-flex items-center gap-0.5">site <ExternalLink size={8} /></a>}
                {a.x402 && <span className="font-mono break-all">x402: {a.x402}</span>}
              </div>
            </div>
          ))}
          {identity && !agents.length && <p>No ERC-8004 agent identity owned by, or pointing at, this wallet.</p>}
          {identity && (
            <p>
              Self Agent ID: {identity.self_verified ? `verified #${identity.self_agent_id ?? "?"}` : identity.self_verified === false ? "not registered" : "unknown"}
              {identity.self_verified ? ` · human proof ${identity.self_human_proof ? "yes" : "no"} · ${identity.self_proof_fresh === false ? "expired" : "fresh"}` : ""}
            </p>
          )}
          {client && (
            <div className="pt-1 border-t border-slate-800">
              <p className="text-slate-500 uppercase tracking-widest text-[8px]">Request claimed</p>
              {client.declared_agent && <p>name: {client.declared_agent}</p>}
              {client.declared_agent_id && <p>ERC-8004 id: {client.declared_agent_id}{agents.some((a) => a.id === client.declared_agent_id) ? " ✓ matches chain" : " ✗ not this wallet's"}</p>}
              <p className="font-mono break-all">UA: {client.user_agent || "none"}</p>
              {client.client_diag != null && <p className="font-mono break-all">client: {JSON.stringify(client.client_diag).slice(0, 200)}</p>}
            </div>
          )}
          {identity && (
            <p className="text-slate-600">
              checked {new Date(identity.checked_at).toLocaleString()}
              {identity.lookup_error ? ` · partial: ${identity.lookup_error}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
