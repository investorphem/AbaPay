import { CheckCircle2, ExternalLink, Share2, HelpCircle, XCircle } from "lucide-react";

export default function ReceiptModal({ 
  receipt, 
  isMainnet, 
  onClose, 
  onShare, 
  onSupport 
}: { 
  receipt: any; 
  isMainnet: boolean; 
  onClose: () => void; 
  onShare: () => void; 
  onSupport: () => void; 
}) {
  if (!receipt) return null;

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
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">{receipt.service === 'Electricity' ? 'Meter Number' : receipt.service === 'Send Money' || receipt.service === 'Bank Transfer' ? 'Account No' : 'Recipient'}</span>
                <span className="text-slate-800 font-mono font-bold text-xs">{receipt.account}</span>
             </div>
             {receipt.request_id && (
               <div className="flex justify-between border-b border-slate-100 pb-3">
                  <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Transaction ID</span>
                  <span className="text-slate-800 font-mono font-bold text-[10px]">{receipt.request_id}</span>
               </div>
             )}
             {receipt.units && receipt.units !== "N/A" && (receipt.service?.toUpperCase() === 'ELECTRICITY' || receipt.service === 'Electricity') && (
               <div className="flex justify-between border-b border-slate-100 pb-3">
                  <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Purchased Units</span>
                  <span className="text-slate-800 font-black text-xs">{receipt.units} kWh</span>
               </div>
             )}
             <div className="flex justify-between border-b border-slate-100 pb-3">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Amount Paid</span>
                <div className="text-right">
                   <p className="text-slate-800 font-black text-sm">₦{receipt.amountNaira}</p>
                   <p className="text-slate-400 text-[9px] font-bold">{receipt.amountCrypto} {receipt.tokenUsed || 'USD₮'}</p>
                </div>
             </div>
             {receipt.status === 'SUCCESS' && receipt.purchased_code && receipt.purchased_code !== "Vended Successfully" && (receipt.service?.toUpperCase() === 'ELECTRICITY' || receipt.service === 'Electricity') && (
               <div className="mt-4 bg-orange-50 border-2 border-orange-200 rounded-xl p-4 text-center">
                  <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest mb-1">Meter Token PIN</p>
                  <p className="font-mono text-xl font-black text-slate-900 tracking-[0.2em] break-all">{receipt.purchased_code.replace(/token\s*[:\-]*\s*/gi, '').trim()}</p>
                  <p className="text-[9px] font-bold text-orange-500 mt-2">Enter this exactly as shown into your meter.</p>
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
