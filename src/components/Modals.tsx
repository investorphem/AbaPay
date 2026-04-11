import { CheckCircle2, ExternalLink, Share2, HelpCircle, XCircle, Loader2 } from "lucide-react";
import { SUPPORTED_COUNTRIES, SUPPORTED_TOKENS } from "@/constants";

export function TermsModal({ isOpen, onClose }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={onClose}>
       <div className="bg-white w-full max-w-md rounded-[2rem] shadow-2xl p-6 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 pb-4">
            <h2 className="text-xl font-black tracking-tight text-slate-900">Terms of Service</h2>
            <button onClick={onClose} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
          </div>
          <div className="overflow-y-auto text-sm text-slate-600 space-y-4 pr-2 leading-relaxed">
             <p className="font-bold text-slate-800">1. Acceptance of Terms</p>
             <p>By connecting your wallet and using the AbaPay Protocol, you agree to execute blockchain transactions via smart contracts. You acknowledge that blockchain transactions are immutable.</p>
             <p className="font-bold text-slate-800 mt-4">2. Service Delivery</p>
             <p>AbaPay acts as a decentralized bridge to fiat utility providers. While we strive for instant vending, delays caused by third-party telecom or electricity providers are beyond our direct control.</p>
             <p className="font-bold text-slate-800 mt-4">3. Supported Assets</p>
             <p>You are responsible for ensuring you send the correct supported asset on the Celo Network. AbaPay is not liable for funds lost due to incorrect network transfers.</p>
          </div>
       </div>
    </div>
  );
}

export function PrivacyModal({ isOpen, onClose }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={onClose}>
       <div className="bg-white w-full max-w-md rounded-[2rem] shadow-2xl p-6 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 pb-4">
            <h2 className="text-xl font-black tracking-tight text-slate-900">Privacy Policy</h2>
            <button onClick={onClose} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
          </div>
          <div className="overflow-y-auto text-sm text-slate-600 space-y-4 pr-2 leading-relaxed">
             <p className="font-bold text-slate-800">1. Data Collection</p>
             <p>As a decentralized application, AbaPay does not require you to create an account or provide personal KYC information. We only collect the data necessary to fulfill your utility order.</p>
             <p className="font-bold text-slate-800 mt-4">2. Wallet Addresses</p>
             <p>Your connected Celo wallet address is recorded on the public blockchain when executing a transaction. This is a fundamental property of Web3 and is not hidden.</p>
          </div>
       </div>
    </div>
  );
}

export function ReceiptModal({ receipt, isMainnet, onClose, onShare, onSupport }: any) {
  if (!receipt) return null;

  // ⚡ DYNAMIC PIN DETECTION ⚡
  const hasPin = receipt.status === 'SUCCESS' && receipt.purchased_code && receipt.purchased_code !== "Vended Successfully";
  const isElectricity = receipt.service?.toUpperCase() === 'ELECTRICITY' || receipt.service === 'Electricity';
  const isEducation = receipt.service === 'Education PIN' || receipt.service?.toUpperCase().includes('WAEC') || receipt.service?.toUpperCase().includes('JAMB');

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/80 backdrop-blur-md flex justify-center items-center p-6 animate-in fade-in" onClick={onClose}>
       <div className="bg-white w-full max-w-sm rounded-[2.5rem] overflow-hidden shadow-2xl animate-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
          <div className="bg-emerald-600 p-8 text-white text-center relative">
             <button onClick={onClose} className="absolute top-4 right-4 bg-white/20 p-1.5 rounded-full hover:bg-white/30 transition-colors"><XCircle size={20}/></button>
             <CheckCircle2 size={48} className="mx-auto mb-3 opacity-90" />
             <h2 className="text-xl font-black tracking-tight">Payment Receipt</h2>
             <p className="text-emerald-100 text-xs font-bold uppercase tracking-widest mt-1">AbaPay Secured</p>
          </div>
          <div className="p-8 space-y-4">
             <div className="flex justify-between border-b border-slate-100 pb-3">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Status</span>
                <span className={`font-black text-xs uppercase ${receipt.status === 'SUCCESS' ? 'text-emerald-600' : receipt.status === 'REFUNDED' ? 'text-blue-600' : 'text-orange-500'}`}>{receipt.status}</span>
             </div>
             <div className="flex justify-between border-b border-slate-100 pb-3">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Date & Time</span>
                <span className="text-slate-800 font-bold text-xs">{receipt.date}</span>
             </div>
             <div className="flex justify-between border-b border-slate-100 pb-3">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Service</span>
                <span className="text-slate-800 font-black text-xs text-right w-2/3 uppercase">{receipt.network} {receipt.service}</span>
             </div>
             <div className="flex justify-between border-b border-slate-100 pb-3">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">
                  {isElectricity ? 'Meter Number' : isEducation ? 'Customer Phone' : receipt.service === 'Send Money' || receipt.service === 'Bank Transfer' ? 'Account No' : 'Recipient'}
                </span>
                <span className="text-slate-800 font-mono font-bold text-xs">{receipt.account}</span>
             </div>
             {receipt.request_id && (
               <div className="flex justify-between border-b border-slate-100 pb-3">
                  <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Transaction ID</span>
                  <span className="text-slate-800 font-mono font-bold text-[10px]">{receipt.request_id}</span>
               </div>
             )}
             {receipt.units && receipt.units !== "N/A" && isElectricity && (
               <div className="flex justify-between border-b border-slate-100 pb-3">
                  <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Purchased Units</span>
                  <span className="text-slate-800 font-black text-xs">{receipt.units} kWh</span>
               </div>
             )}
             <div className="flex justify-between border-b border-slate-100 pb-3">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Amount Paid</span>
                <div className="text-right">
                   {/* ⚡ APPLIED FORMATTING HERE ⚡ */}
                   <p className="text-slate-800 font-black text-sm">₦{Number(receipt.amountNaira).toLocaleString()}</p>
                   <p className="text-slate-400 text-[9px] font-bold">{receipt.amountCrypto} {receipt.tokenUsed || 'USD₮'}</p>
                </div>
             </div>

             {/* ⚡ EDU & ELEC PIN RENDERER ⚡ */}
             {hasPin && (
               <div className="mt-4 bg-emerald-50 border-2 border-emerald-200 rounded-xl p-4 text-center">
                  <p className="text-[10px] font-black text-emerald-700 uppercase tracking-widest mb-1">{isElectricity ? 'Meter Token PIN' : 'Purchased Education PIN'}</p>
                  <p className="font-mono text-sm sm:text-base font-black text-slate-900 tracking-wide break-all">{isElectricity ? receipt.purchased_code.replace(/token\s*[:\-]*\s*/gi, '').trim() : receipt.purchased_code}</p>
                  <p className="text-[9px] font-bold text-emerald-600 mt-2">{isElectricity ? 'Enter this exactly as shown into your meter.' : 'Please keep this PIN/Serial Number safe.'}</p>
               </div>
             )}

             {receipt.status === 'REFUNDED' && receipt.refund_hash && (
               <div className="flex justify-between border-b border-slate-100 pb-3">
                  <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Refund Hash</span>
                  <a href={`https://${isMainnet?'':'sepolia.'}celoscan.io/tx/${receipt.refund_hash}`} target="_blank" className="text-blue-600 font-mono font-bold text-xs flex items-center justify-end gap-1 hover:underline">View Transfer <ExternalLink size={10}/></a>
               </div>
             )}
             <button onClick={() => window.open(`https://${isMainnet?'':'sepolia.'}celoscan.io/tx/${receipt.txHash}`)} className="w-full py-3 bg-slate-50 hover:bg-slate-100 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center justify-center gap-2 transition-colors">Verify on Celoscan <ExternalLink size={12}/></button>
             <div className="flex gap-2">
                <button onClick={onShare} className="flex-1 py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95 shadow-xl shadow-slate-900/20"><Share2 size={16}/> Share</button>
                {receipt.status !== 'SUCCESS' && receipt.status !== 'REFUNDED' && (
                   <button onClick={onSupport} className="flex-1 py-4 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"><HelpCircle size={16}/> Support</button>
                )}
             </div>
          </div>
       </div>
    </div>
  );
}

export function SelectionModal({
  isOpen, onClose, title, type, options, onSelect, isFetchingBanks, selectedValue, onRetryBanks
}: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={onClose}>
       <div className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl p-6 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6 shrink-0 border-b border-slate-100 pb-4">
            <h2 className="text-xl font-black text-slate-900 tracking-tight">{title}</h2>
            <button onClick={onClose} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
          </div>
          <div className="space-y-2.5 max-h-[50vh] overflow-y-auto pr-1">

             {type === 'country' && SUPPORTED_COUNTRIES.map(country => (
               <button key={country.code} disabled={country.disabled} onClick={() => { if (!country.disabled) { onSelect(country.code); onClose(); } }}
                 className={`w-full text-left p-4 rounded-xl font-bold text-sm transition-all flex justify-between items-center ${country.disabled ? 'bg-slate-50 border border-slate-100 text-slate-400 cursor-not-allowed' : 'text-slate-700 bg-slate-50 border border-slate-100 hover:border-emerald-300 hover:bg-emerald-50/50'}`}>
                 <div className="flex items-center gap-3"><span className="text-2xl">{country.flag}</span><span className={`font-black ${country.disabled ? 'text-slate-400' : 'text-slate-800'}`}>{country.name}</span></div>
                 {selectedValue === country.code && <CheckCircle2 size={18} className="text-emerald-500"/>}
               </button>
             ))}

             {type === 'bank' && isFetchingBanks && (
               <div className="flex flex-col items-center justify-center p-6 gap-3 text-slate-400">
                 <Loader2 className="animate-spin text-blue-500" size={24} />
                 <span className="text-xs font-bold uppercase tracking-widest">Connecting to NIBSS...</span>
               </div>
             )}
             {type === 'bank' && !isFetchingBanks && (!options || options.length === 0) && (
               <div className="p-6 text-center text-slate-500 font-bold text-xs flex flex-col items-center gap-3">
                 No banks available.
                 <button onClick={onRetryBanks} className="bg-blue-100 text-blue-600 px-4 py-2 rounded-xl text-xs font-bold w-full">Retry Connection</button>
               </div>
             )}
             {type === 'bank' && !isFetchingBanks && options?.map((bank: any) => (
               <button key={bank.variation_code} onClick={() => { onSelect(bank.variation_code); onClose(); }} className="w-full text-left p-4 rounded-xl font-bold text-slate-700 bg-slate-50 border border-slate-100 text-xs hover:border-blue-300 hover:bg-blue-50/50 transition-all flex justify-between items-center">
                 <span>{bank.name}</span>
                 {selectedValue === bank.variation_code && <CheckCircle2 size={18} className="text-blue-500"/>}
               </button>
             ))}

             {type === 'token' && SUPPORTED_TOKENS.map(token => (
               <button key={token.symbol} onClick={() => { onSelect(token.symbol); onClose(); }} className="w-full text-left p-4 rounded-xl font-bold text-slate-700 bg-slate-50 border border-slate-100 uppercase text-xs hover:border-emerald-300 hover:bg-emerald-50/50 transition-all flex justify-between items-center">
                 <div className="flex items-center gap-3"><img src={token.logo} alt={token.symbol} className="w-6 h-6 object-contain rounded-full shadow-sm bg-white" /><span className="text-sm font-black text-slate-800 tracking-tight">{token.symbol}</span></div>
                 {selectedValue === token.symbol && <CheckCircle2 size={18} className="text-emerald-500"/>}
               </button>
             ))}

             {type === 'provider' && (options as any[]).map(provider => (
                <button key={provider.serviceID} onClick={() => { onSelect(provider.serviceID); onClose(); }} className="w-full text-left p-4 rounded-2xl font-bold text-slate-700 bg-white border hover:bg-slate-50 transition-all flex justify-between items-center group hover:border-slate-300">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-sm overflow-hidden group-hover:shadow-md transition-shadow">
                            <img src={provider.logo || '/logo.png'} alt={provider.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                        </div>
                        <div><span className="text-sm font-black text-slate-900 tracking-tight">{provider.displayName}</span></div>
                    </div>
                    {selectedValue === provider.serviceID && <CheckCircle2 size={20} className="text-emerald-500"/>}
                </button>
             ))}

             {type === 'standard' && (options as any[]).map(provider => (
                <button key={provider.serviceID} onClick={() => { onSelect(provider.serviceID); onClose(); }} className="w-full text-left p-4 rounded-2xl font-bold text-slate-700 bg-white border hover:bg-slate-50 transition-all flex justify-between items-center group hover:border-emerald-300">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-sm overflow-hidden group-hover:shadow-md transition-shadow">
                            <img src={provider.logo || '/logo.png'} alt={provider.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                        </div>
                        <div><span className="text-sm font-black text-slate-900 tracking-tight uppercase">{provider.displayName}</span></div>
                    </div>
                    {selectedValue === provider.serviceID && <CheckCircle2 size={20} className="text-emerald-500"/>}
                </button>
             ))}
          </div>
       </div>
    </div>
  );
}
