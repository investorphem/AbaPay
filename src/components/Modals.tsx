import React, { useRef, useState, useEffect } from "react";
import { CheckCircle2, ExternalLink, Share2, HelpCircle, XCircle, Loader2, Search } from "lucide-react";
import { SUPPORTED_COUNTRIES, SUPPORTED_TOKENS } from "@/constants";

// ⚡ International transactions store a pre-formatted currency string (e.g. "GHS 2.50").
// Domestic transactions store a plain NGN number. Render each correctly instead of forcing ₦ on everything.
function formatTxAmount(amountNaira: any) {
  const num = Number(amountNaira);
  return isNaN(num) ? amountNaira : `₦${num.toLocaleString()}`;
}

export function TermsModal({ isOpen, onClose }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-black/80 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in transition-colors" onClick={onClose}>
       <div className="bg-white dark:bg-[#111114] w-full max-w-md rounded-[2rem] shadow-2xl dark:shadow-black/50 p-6 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200 transition-colors" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 dark:border-slate-800/60 pb-4">
            <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">Terms of Service</h2>
            <button onClick={onClose} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"><XCircle size={20} className="text-slate-500 dark:text-slate-400" /></button>
          </div>
          <div className="overflow-y-auto text-sm text-slate-600 dark:text-slate-300 space-y-4 pr-2 leading-relaxed">
             <p className="font-bold text-slate-800 dark:text-slate-100">1. Acceptance of Terms</p>
             <p>By connecting your wallet and using the AbaPay Protocol, you agree to execute blockchain transactions via smart contracts. You acknowledge that blockchain transactions are immutable.</p>
             <p className="font-bold text-slate-800 dark:text-slate-100 mt-4">2. Service Delivery</p>
             <p>AbaPay acts as a decentralized bridge to fiat utility providers. While we strive for instant vending, delays caused by third-party telecom or electricity providers are beyond our direct control.</p>
             <p className="font-bold text-slate-800 dark:text-slate-100 mt-4">3. Supported Assets</p>
             <p>You are responsible for ensuring you send the correct supported asset on the Celo Network. AbaPay is not liable for funds lost due to incorrect network transfers.</p>
          </div>
       </div>
    </div>
  );
}

export function PrivacyModal({ isOpen, onClose }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-black/80 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in transition-colors" onClick={onClose}>
       <div className="bg-white dark:bg-[#111114] w-full max-w-md rounded-[2rem] shadow-2xl dark:shadow-black/50 p-6 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200 transition-colors" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 dark:border-slate-800/60 pb-4">
            <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">Privacy Policy</h2>
            <button onClick={onClose} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"><XCircle size={20} className="text-slate-500 dark:text-slate-400" /></button>
          </div>
          <div className="overflow-y-auto text-sm text-slate-600 dark:text-slate-300 space-y-4 pr-2 leading-relaxed">
             <p className="font-bold text-slate-800 dark:text-slate-100">1. Data Collection</p>
             <p>As a decentralized application, AbaPay does not require you to create an account or provide personal KYC information. We only collect the data necessary to fulfill your utility order.</p>
             <p className="font-bold text-slate-800 dark:text-slate-100 mt-4">2. Wallet Addresses</p>
             <p>Your connected Celo wallet address is recorded on the public blockchain when executing a transaction. This is a fundamental property of Web3 and is not hidden.</p>
          </div>
       </div>
    </div>
  );
}

export function ReceiptModal({ receipt, isMainnet, onClose, onSupport }: any) {
  if (!receipt) return null;

  const [isProcessingShare, setIsProcessingShare] = useState(false);
  const [saveOptions, setSaveOptions] = useState<{ dataUrl: string; canvas: HTMLCanvasElement } | null>(null);

  const hasPin = receipt.status === 'SUCCESS' && receipt.purchased_code && receipt.purchased_code !== "Vended Successfully";
  const isElectricity = receipt.service?.toUpperCase() === 'ELECTRICITY' || receipt.service === 'Electricity';
  const isEducation = receipt.service === 'Education PIN' || receipt.service?.toUpperCase().includes('WAEC') || receipt.service?.toUpperCase().includes('JAMB');

  const buildFallbackText = () => `🧾 AbaPay Receipt\n\nService: ${receipt.network} ${receipt.service}\nAmount: ${formatTxAmount(receipt.amountNaira)}\nStatus: ${receipt.status}\nAccount: ${receipt.account}\nRef: ${receipt.id}\n${hasPin ? `\nPIN/TOKEN: ${receipt.purchased_code}` : ''}\n\nSecured by ${receipt.blockchain || 'Celo'} ⚡`;

  // ⚡ SHARE: Always render the receipt to an image first, then hand it to the
  // device's native share sheet so the user can send it via WhatsApp, Telegram,
  // Photos, Files, etc. — the same way any other app shares an image.
  const handleShareImage = async () => {
    setIsProcessingShare(true);
    setSaveOptions(null);

    try {
      const receiptElement = document.getElementById('printable-receipt');
      if (!receiptElement) return;

      const html2canvas = (await import('html2canvas-pro')).default;
      const canvas = await html2canvas(receiptElement, {
          scale: 2,
          backgroundColor: null // Captures dark mode perfectly
      });

      const dataUrl = canvas.toDataURL('image/png');
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `AbaPay_Receipt_${receipt.id}.png`, { type: 'image/png' });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: 'AbaPay Receipt',
            text: 'Here is my AbaPay transaction receipt!',
          });
          return; // Shared successfully via the system sheet
        } catch (shareErr: any) {
          if (shareErr?.name === 'AbortError') return; // User closed the share sheet — don't force a download on them
          // Any other share failure falls through to the manual save options below
        }
      }

      // No native "share files" support on this browser/wallet webview (e.g. desktop, some in-app browsers)
      // — let the user explicitly choose how to save the receipt instead of silently copying text.
      setSaveOptions({ dataUrl, canvas });
    } catch (error) {
      console.error('Error generating receipt image:', error);
      // Last-resort fallback only if image generation itself fails entirely
      try {
        const fallbackText = buildFallbackText();
        if (navigator.share) await navigator.share({ title: 'AbaPay Receipt', text: fallbackText });
        else { await navigator.clipboard.writeText(fallbackText); alert("Couldn't generate a receipt image, so the details were copied to your clipboard instead."); }
      } catch (fallbackErr) {
        console.log("Fallback share failed.");
      }
    } finally {
      setIsProcessingShare(false);
    }
  };

  const handleSaveAsImage = () => {
    if (!saveOptions) return;
    const link = document.createElement('a');
    link.download = `AbaPay_Receipt_${receipt.id}.png`;
    link.href = saveOptions.dataUrl;
    link.click();
    setSaveOptions(null);
  };

  const handleSaveAsPDF = async () => {
    if (!saveOptions) return;
    try {
      const { jsPDF } = await import('jspdf');
      const { canvas, dataUrl } = saveOptions;
      const widthMm = 100; // Receipt-sized page, scaled to the captured canvas's aspect ratio
      const heightMm = (canvas.height * widthMm) / canvas.width;
      const pdf = new jsPDF({ orientation: heightMm >= widthMm ? 'portrait' : 'landscape', unit: 'mm', format: [widthMm, heightMm] });
      pdf.addImage(dataUrl, 'PNG', 0, 0, widthMm, heightMm);
      pdf.save(`AbaPay_Receipt_${receipt.id}.pdf`);
    } catch (error) {
      console.error('Error generating receipt PDF:', error);
      alert("Couldn't generate the PDF. Please try saving as an image instead.");
    } finally {
      setSaveOptions(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/80 dark:bg-black/90 backdrop-blur-md flex justify-center items-center p-6 animate-in fade-in transition-colors" onClick={onClose}>
       <div className="bg-white dark:bg-[#111114] w-full max-w-sm rounded-[2.5rem] overflow-hidden shadow-2xl dark:shadow-black/50 animate-in zoom-in-95 transition-colors" onClick={(e) => e.stopPropagation()}>

          <div id="printable-receipt" className="bg-white dark:bg-[#111114] transition-colors">
            <div className="bg-emerald-600 dark:bg-emerald-800 p-8 text-white text-center relative transition-colors">
               <button data-html2canvas-ignore="true" onClick={onClose} className="absolute top-4 right-4 bg-white/20 p-1.5 rounded-full hover:bg-white/30 transition-colors"><XCircle size={20}/></button>
               <CheckCircle2 size={48} className="mx-auto mb-3 opacity-90" />
               <h2 className="text-xl font-black tracking-tight">Payment Receipt</h2>
               <p className="text-emerald-100 text-xs font-bold uppercase tracking-widest mt-1">AbaPay Secured</p>
            </div>

            <div className="p-8 space-y-4">
               <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                  <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Status</span>
                  <span className={`font-black text-xs uppercase ${receipt.status === 'SUCCESS' ? 'text-emerald-600 dark:text-emerald-500' : receipt.status === 'REFUNDED' ? 'text-blue-600 dark:text-blue-500' : 'text-orange-500 dark:text-orange-400'}`}>{receipt.status}</span>
               </div>
               <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                  <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Date & Time</span>
                  <span className="text-slate-800 dark:text-slate-200 font-bold text-xs">{receipt.date}</span>
               </div>
               <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                  <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Service</span>
                  <span className="text-slate-800 dark:text-slate-200 font-black text-xs text-right w-2/3 uppercase">{receipt.network} {receipt.service}</span>
               </div>
               <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                  <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">
                    {isElectricity ? 'Meter Number' : isEducation ? 'Customer Phone' : receipt.service === 'Send Money' || receipt.service === 'Bank Transfer' ? 'Account No' : 'Recipient'}
                  </span>
                  <span className="text-slate-800 dark:text-slate-200 font-mono font-bold text-xs">{receipt.account}</span>
               </div>
               {receipt.request_id && (
                 <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                    <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Transaction ID</span>
                    <span className="text-slate-800 dark:text-slate-200 font-mono font-bold text-[10px]">{receipt.request_id}</span>
                 </div>
               )}
               {receipt.units && receipt.units !== "N/A" && isElectricity && (
                 <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                    <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Purchased Units</span>
                    <span className="text-slate-800 dark:text-slate-200 font-black text-xs">{receipt.units} kWh</span>
                 </div>
               )}
               <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                  <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Amount Paid</span>
                  <div className="text-right">
                     <p className="text-slate-800 dark:text-slate-100 font-black text-sm">{formatTxAmount(receipt.amountNaira)}</p>
                     <p className="text-slate-400 dark:text-slate-500 text-[9px] font-bold">{receipt.amountCrypto} {receipt.tokenUsed || 'USD₮'}</p>
                  </div>
               </div>

               {hasPin && (
                 <div className="mt-4 bg-emerald-50 dark:bg-emerald-900/20 border-2 border-emerald-200 dark:border-emerald-800/50 rounded-xl p-4 text-center transition-colors">
                    <p className="text-[10px] font-black text-emerald-700 dark:text-emerald-400 uppercase tracking-widest mb-1">{isElectricity ? 'Meter Token PIN' : 'Purchased Education PIN'}</p>
                    <p className="font-mono text-sm sm:text-base font-black text-slate-900 dark:text-emerald-100 tracking-wide break-all">{isElectricity ? receipt.purchased_code.replace(/token\s*[:\-]*\s*/gi, '').trim() : receipt.purchased_code}</p>
                    <p className="text-[9px] font-bold text-emerald-600 dark:text-emerald-500 mt-2">{isElectricity ? 'Enter this exactly as shown into your meter.' : 'Please keep this PIN/Serial Number safe.'}</p>
                 </div>
               )}

               {/* ⚡ MULTI-CHAIN REFUND HASH LINK ⚡ */}
               {receipt.status === 'REFUNDED' && receipt.refund_hash && (
                 <div className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3 transition-colors">
                    <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-wider">Refund Hash</span>
                    {(() => {
                        const isBaseTx = receipt?.blockchain?.toUpperCase().includes('BASE');
                        const refundUrl = isBaseTx 
                            ? (isMainnet ? `https://basescan.org/tx/${receipt.refund_hash}` : `https://sepolia.basescan.org/tx/${receipt.refund_hash}`)
                            : (isMainnet ? `https://celoscan.io/tx/${receipt.refund_hash}` : `https://alfajores.celoscan.io/tx/${receipt.refund_hash}`);

                        return (
                            <a data-html2canvas-ignore="true" href={refundUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 font-mono font-bold text-xs flex items-center justify-end gap-1 hover:underline transition-colors">
                                View Transfer <ExternalLink size={10}/>
                            </a>
                        );
                    })()}
                 </div>
               )}

               <div className="mt-6 pt-4 border-t border-dashed border-slate-200 dark:border-slate-800 text-center transition-colors">
                  <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Pay Utility Bills with Crypto ⚡</p>
                  <p className="text-sm font-black text-emerald-600 dark:text-emerald-500">www.abapays.com</p>
               </div>
            </div>
          </div>

          <div className="px-8 pb-8 space-y-3">
             {/* ⚡ MULTI-CHAIN VERIFY BUTTON ⚡ */}
             {(() => {
                 const isBaseTx = receipt?.blockchain?.toUpperCase().includes('BASE');
                 const explorerName = isBaseTx ? "Basescan" : "Celoscan";
                 const explorerUrl = isBaseTx 
                     ? (isMainnet ? `https://basescan.org/tx/${receipt?.txHash}` : `https://sepolia.basescan.org/tx/${receipt?.txHash}`)
                     : (isMainnet ? `https://celoscan.io/tx/${receipt?.txHash}` : `https://alfajores.celoscan.io/tx/${receipt?.txHash}`);

                 return (
                     <button 
                         onClick={() => window.open(explorerUrl)} 
                         className="w-full py-3 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2 transition-colors"
                     >
                         Verify on {explorerName} <ExternalLink size={12}/>
                     </button>
                 );
             })()}

             <div className="flex gap-2">
                <button 
                  onClick={handleShareImage} 
                  className="flex-1 py-4 bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-200 text-white dark:text-slate-900 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95 shadow-xl shadow-slate-900/20 dark:shadow-white/10"
                >
                  <Share2 size={16}/> SHARE
                </button>
                {receipt.status !== 'SUCCESS' && receipt.status !== 'REFUNDED' && (
                   <button onClick={onSupport} className="flex-1 py-4 bg-orange-100 dark:bg-orange-900/20 hover:bg-orange-200 dark:hover:bg-orange-900/40 text-orange-700 dark:text-orange-400 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"><HelpCircle size={16}/> Support</button>
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
  const [searchQuery, setSearchQuery] = useState("");

  // Clear the search bar whenever the modal opens
  useEffect(() => {
    if (isOpen) setSearchQuery("");
  }, [isOpen]);

  if (!isOpen) return null;

  // ⚡ SMART FILTER: Searches by name, displayName, or code ⚡
  const filteredOptions = (options || []).filter((opt: any) => {
    if (!searchQuery) return true;
    const nameToSearch = (opt.name || opt.displayName || opt.code || "").toLowerCase();
    return nameToSearch.includes(searchQuery.toLowerCase());
  });

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-black/80 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in transition-colors" onClick={onClose}>
       <div className="bg-white dark:bg-[#111114] w-full max-w-sm rounded-[2rem] shadow-2xl dark:shadow-black/50 p-6 animate-in zoom-in-95 duration-200 transition-colors" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 dark:border-slate-800/60 pb-4">
            <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">{title}</h2>
            <button onClick={onClose} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"><XCircle size={20} className="text-slate-500 dark:text-slate-400" /></button>
          </div>

          {/* ⚡ NEW SEARCH BAR ⚡ */}
          {(type === 'country' || type === 'bank' || (options && options.length > 10)) && (
            <div className="relative mb-4">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" size={16} />
                <input 
                    type="text" 
                    placeholder={`Search ${type === 'country' ? 'country' : 'options'}...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 rounded-xl py-3 pl-10 pr-4 text-sm font-bold text-slate-700 dark:text-white outline-none focus:border-emerald-500 dark:focus:border-emerald-500 transition-all shadow-inner"
                />
            </div>
          )}

          <div className="space-y-2.5 max-h-[50vh] overflow-y-auto pr-1">

             {/* NO RESULTS FALLBACK */}
             {filteredOptions.length === 0 && !isFetchingBanks && (
                <div className="p-6 text-center text-slate-400 dark:text-slate-500 font-bold text-xs flex flex-col items-center gap-2">
                   <Search size={24} className="text-slate-300 dark:text-slate-600 mb-1" />
                   No results found for "{searchQuery}"
                </div>
             )}

             {/* ⚡ COUNTRY SELECTOR ⚡ */}
             {type === 'country' && filteredOptions.map((country: any) => (
               <button key={country.code} disabled={country.disabled} onClick={() => { if (!country.disabled) { onSelect(country.code); onClose(); } }}
                 className={`w-full text-left p-4 rounded-xl font-bold text-sm transition-all flex justify-between items-center ${country.disabled ? 'bg-slate-50 dark:bg-[#1a1a1f]/50 border border-slate-100 dark:border-slate-800/50 text-slate-400 dark:text-slate-600 cursor-not-allowed' : 'text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20'}`}>
                 <div className="flex items-center gap-3">
                   <img 
                     src={`https://flagcdn.com/w40/${country.code.toLowerCase()}.png`} 
                     alt={country.name} 
                     className={`w-7 h-auto rounded-sm shadow-sm ${country.disabled ? 'opacity-50 grayscale' : ''}`} 
                     onError={(e) => { e.currentTarget.style.display = 'none'; }}
                   />
                   <span className={`font-black ${country.disabled ? 'text-slate-400 dark:text-slate-600' : 'text-slate-800 dark:text-slate-200'}`}>{country.name}</span>
                 </div>
                 {selectedValue === country.code && <CheckCircle2 size={18} className="text-emerald-500"/>}
               </button>
             ))}

             {/* ⚡ BANK SELECTOR ⚡ */}
             {type === 'bank' && isFetchingBanks && (
               <div className="flex flex-col items-center justify-center p-6 gap-3 text-slate-400 dark:text-slate-500">
                 <Loader2 className="animate-spin text-blue-500 dark:text-blue-400" size={24} />
                 <span className="text-xs font-bold uppercase tracking-widest">Connecting to NIBSS...</span>
               </div>
             )}
             {type === 'bank' && !isFetchingBanks && (!options || options.length === 0) && (
               <div className="p-6 text-center text-slate-500 dark:text-slate-400 font-bold text-xs flex flex-col items-center gap-3">
                 No banks available.
                 <button onClick={onRetryBanks} className="bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 px-4 py-2 rounded-xl text-xs font-bold w-full transition-colors">Retry Connection</button>
               </div>
             )}
             {type === 'bank' && !isFetchingBanks && filteredOptions.map((bank: any) => (
               <button key={bank.variation_code} onClick={() => { onSelect(bank.variation_code); onClose(); }} className="w-full text-left p-4 rounded-xl font-bold text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 text-xs hover:border-blue-300 dark:hover:border-blue-700 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-all flex justify-between items-center">
                 <span>{bank.name}</span>
                 {selectedValue === bank.variation_code && <CheckCircle2 size={18} className="text-blue-500"/>}
               </button>
             ))}

             {/* ⚡ TOKEN SELECTOR ⚡ */}
             {type === 'token' && filteredOptions.map((token: any) => (
               <button key={token.symbol} onClick={() => { onSelect(token.symbol); onClose(); }} className="w-full text-left p-4 rounded-xl font-bold text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 normal-case text-xs hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20 transition-all flex justify-between items-center">
                 <div className="flex items-center gap-3"><img src={token.logo} alt={token.symbol} className="w-6 h-6 object-contain rounded-full shadow-sm bg-white dark:bg-slate-800 p-0.5" /><span className="text-sm font-black text-slate-800 dark:text-slate-200 tracking-tight">{token.symbol}</span></div>
                 {selectedValue === token.symbol && <CheckCircle2 size={18} className="text-emerald-500"/>}
               </button>
             ))}

             {/* ⚡ PROVIDER SELECTOR ⚡ */}
             {type === 'provider' && filteredOptions.map((provider: any) => (
                <button 
                  key={provider.serviceID} 
                  disabled={provider.disabled}
                  onClick={() => { if (!provider.disabled) { onSelect(provider.serviceID); onClose(); } }} 
                  className={`w-full text-left p-4 rounded-2xl font-bold transition-all flex justify-between items-center group ${provider.disabled ? 'bg-slate-50 dark:bg-[#1a1a1f]/50 border border-slate-100 dark:border-slate-800/50 opacity-60 grayscale cursor-not-allowed' : 'text-slate-700 dark:text-slate-300 bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-[#1a1a1f] hover:border-slate-300 dark:hover:border-slate-700'}`}
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-800 p-0.5 flex items-center justify-center shadow-sm overflow-hidden">
                            <img src={provider.logo || '/logo.png'} alt={provider.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                        </div>
                        <div className="flex flex-col">
                            <span className={`text-sm font-black tracking-tight ${provider.disabled ? 'text-slate-500 dark:text-slate-600' : 'text-slate-900 dark:text-white'}`}>{provider.displayName}</span>
                            {provider.disabled && <span className="text-[9px] font-bold text-red-500 dark:text-red-400 uppercase tracking-widest mt-0.5">Temporarily Offline</span>}
                        </div>
                    </div>
                    {selectedValue === provider.serviceID && !provider.disabled && <CheckCircle2 size={20} className="text-emerald-500"/>}
                </button>
             ))}

             {/* ⚡ STANDARD SELECTOR ⚡ */}
             {type === 'standard' && filteredOptions.map((provider: any) => (
                <button 
                  key={provider.serviceID} 
                  disabled={provider.disabled}
                  onClick={() => { if (!provider.disabled) { onSelect(provider.serviceID); onClose(); } }} 
                  className={`w-full text-left p-4 rounded-2xl font-bold transition-all flex justify-between items-center group ${provider.disabled ? 'bg-slate-50 dark:bg-[#1a1a1f]/50 border border-slate-100 dark:border-slate-800/50 opacity-60 grayscale cursor-not-allowed' : 'text-slate-700 dark:text-slate-300 bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-[#1a1a1f] hover:border-emerald-300 dark:hover:border-emerald-700'}`}
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-800 p-0.5 flex items-center justify-center shadow-sm overflow-hidden">
                            <img src={provider.logo || '/logo.png'} alt={provider.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                        </div>
                        <div className="flex flex-col">
                            <span className={`text-sm font-black tracking-tight uppercase ${provider.disabled ? 'text-slate-500 dark:text-slate-600' : 'text-slate-900 dark:text-white'}`}>{provider.displayName}</span>
                            {provider.disabled && <span className="text-[9px] font-bold text-red-500 dark:text-red-400 uppercase tracking-widest mt-0.5">Temporarily Offline</span>}
                        </div>
                    </div>
                    {selectedValue === provider.serviceID && !provider.disabled && <CheckCircle2 size={20} className="text-emerald-500"/>}
                </button>
             ))}
          </div>
       </div>
    </div>
  );
}