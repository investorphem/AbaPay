import React, { useRef, useState, useEffect } from "react";
import { CheckCircle2, ExternalLink, Share2, HelpCircle, XCircle, Loader2, Search, Download } from "lucide-react";
import { SUPPORTED_TOKENS } from "@/constants";

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
  // Real, tappable download links — see handleShareImage's fallback branch for why these
  // replaced a JS-synthesized <a>.click(). Deliberately `data:` URLs, not blob: — a wallet's
  // embedded browser (MiniPay, Base App) routes target="_blank"/new-tab navigation through its
  // OWN native URI dispatcher, and a blob: URL is only ever valid inside the exact document
  // that created it, so handing it to anything outside that document fails immediately with
  // "Can not handle uri:: blob:...". A data: URL is fully self-contained, so there's nothing
  // for an external handler to fail to resolve.
  const [saveOptions, setSaveOptions] = useState<{ imageUrl: string; pdfUrl: string | null } | null>(null);

  const hasPin = receipt.status === 'SUCCESS' && receipt.purchased_code && receipt.purchased_code !== "Vended Successfully";
  const isElectricity = receipt.service?.toUpperCase() === 'ELECTRICITY' || receipt.service === 'Electricity';
  const isEducation = receipt.service === 'Education PIN' || receipt.service?.toUpperCase().includes('WAEC') || receipt.service?.toUpperCase().includes('JAMB');

  const buildFallbackText = () => `🧾 AbaPay Receipt\n\nService: ${receipt.network} ${receipt.service}\nAmount: ${formatTxAmount(receipt.amountNaira)}\nStatus: ${receipt.status}\nAccount: ${receipt.account}\nRef: ${receipt.id}\n${hasPin ? `\nPIN/TOKEN: ${receipt.purchased_code}` : ''}\n\nSecured by ${receipt.blockchain || 'Celo'} ⚡`;

  // ⚡ THE ACTUAL BUG — this project runs Tailwind v4, whose default palette (and every
  // `/opacity` utility like `bg-emerald-900/20`) compiles to `oklch()`/`color-mix()` colors.
  // html2canvas-pro can parse plain oklch(), but NOT color-mix() — which is what almost every
  // opacity-modified color in this receipt (borders, tinted backgrounds, dark-mode variants)
  // actually compiles to. That made html2canvas throw on the FIRST such element it walked,
  // on every device, every time — not a webview quirk, a color-parsing crash before the
  // download/share logic below ever ran, which is exactly why it failed identically on PC,
  // MiniPay AND Base App alike (this has nothing to do with mobile download permissions).
  //
  // 🔴 A PREVIOUS FIX HERE just re-read `getComputedStyle(el)[prop]` and wrote that straight
  // back as an inline style. That doesn't actually help: for a `color-mix()`-sourced value,
  // Chromium/WebKit's `getComputedStyle` frequently still serializes it back out as a literal
  // `"color-mix(in oklab, rgb(6, 78, 59) 20%, transparent)"` string — NOT the resolved rgba() —
  // so we were feeding html2canvas the exact same unparseable syntax it already couldn't read.
  //
  // Real fix: force full numeric resolution ourselves via a 1x1 canvas 2D context. Setting
  // `ctx.fillStyle` to ANY valid CSS color — oklch(), color-mix(), lab(), named colors, all of
  // it — and reading it back is guaranteed by the Canvas 2D spec to yield a plain `#rrggbb` or
  // `rgba(r, g, b, a)` string, independent of the getComputedStyle serialization quirk above.
  const COLOR_PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'] as const;

  let normalizeCtx: CanvasRenderingContext2D | null = null;
  function normalizeColor(input: string): string {
    if (!input) return input;
    if (!normalizeCtx) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      normalizeCtx = c.getContext('2d');
    }
    if (!normalizeCtx) return input; // canvas 2D unavailable — fall back to the raw value
    const SENTINEL = '#010203';
    normalizeCtx.fillStyle = SENTINEL;
    normalizeCtx.fillStyle = input; // invalid input is silently ignored per spec, keeping SENTINEL
    const resolved = normalizeCtx.fillStyle;
    return resolved === SENTINEL && input.toLowerCase() !== SENTINEL ? input : resolved;
  }

  async function withResolvedColors<T>(root: HTMLElement, fn: () => Promise<T>): Promise<T> {
    const elements: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    const snapshots = elements.map((el) => {
      const prev: Partial<Record<typeof COLOR_PROPS[number], string>> = {};
      for (const prop of COLOR_PROPS) prev[prop] = el.style[prop];
      return { el, prev };
    });

    for (const el of elements) {
      const computed = window.getComputedStyle(el);
      for (const prop of COLOR_PROPS) el.style[prop] = normalizeColor(computed[prop]);
    }

    try {
      return await fn();
    } finally {
      for (const { el, prev } of snapshots) {
        for (const prop of COLOR_PROPS) el.style[prop] = prev[prop] || '';
      }
    }
  }

  // ⚡ SHARE: Always render the receipt to an image first, then hand it to the
  // device's native share sheet so the user can send it via WhatsApp, Telegram,
  // Photos, Files, etc. — the same way any other app shares an image.
  const handleShareImage = async () => {
    setIsProcessingShare(true);
    setSaveOptions(null);

    try {
      const receiptElement = document.getElementById('printable-receipt');
      if (!receiptElement) {
        // Previously this returned silently, so the button appeared to do nothing at all.
        console.error('Receipt element #printable-receipt not found.');
        alert("Couldn't prepare the receipt. Please close and reopen it, then try again.");
        return;
      }

      const html2canvas = (await import('html2canvas-pro')).default;
      const canvas = await withResolvedColors(receiptElement, () => html2canvas(receiptElement, {
          scale: 2,
          backgroundColor: null // Captures dark mode perfectly
      }));

      const dataUrl = canvas.toDataURL('image/png');
      // toBlob() rather than fetch(dataUrl) — fetching a base64 data: URI means holding the
      // whole receipt image twice in memory (once as a giant base64 string, once as the
      // decoded blob), which is a known source of silent failures on memory-constrained
      // Android WebViews at scale:2. toBlob() goes straight from canvas to binary.
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('canvas.toBlob returned null — image encoding failed');
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

      // No native "share files" support on this browser/wallet webview (e.g. desktop, some
      // in-app browsers) — build real, tappable download links instead of trying to fake a
      // click programmatically (see the note by the old triggerDownload/handleSaveAs* helpers
      // this replaced: a JS-synthesized `<a download>.click()` is exactly what was silently
      // being treated as a plain navigation in some webviews — dumping the user out of the
      // whole app onto a bare blob: URL with no save affordance, instead of downloading).
      // A real anchor the user physically taps doesn't have that problem — browsers reserve
      // their strictest popup/download suspicion for script-triggered clicks, not genuine ones.
      let pdfUrl: string | null = null;
      try {
        const { jsPDF } = await import('jspdf');
        const widthMm = 100; // Receipt-sized page, scaled to the captured canvas's aspect ratio
        const heightMm = (canvas.height * widthMm) / canvas.width;
        const pdf = new jsPDF({ orientation: heightMm >= widthMm ? 'portrait' : 'landscape', unit: 'mm', format: [widthMm, heightMm] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, widthMm, heightMm);
        pdfUrl = pdf.output('datauristring'); // a self-contained data: URL — see the state comment above for why not blob:
      } catch (pdfErr) {
        console.error('PDF generation failed (image download is still offered):', pdfErr);
      }
      setSaveOptions({ imageUrl: dataUrl, pdfUrl });
    } catch (error: any) {
      console.error('Error generating receipt image:', error?.name, error?.message, error);
      // Last-resort fallback only if image generation itself fails entirely. This used to be
      // able to fail SILENTLY end-to-end: navigator.share(text) or clipboard.writeText() could
      // itself throw (e.g. both APIs blocked inside a wallet's embedded webview) and land in a
      // catch that did nothing but console.log — the button would flash "PREPARING…" and then
      // visibly do nothing at all, indistinguishable from the button being broken. Every branch
      // below now guarantees SOME visible outcome. (Deliberately no alert() BEFORE the
      // navigator.share() call: a blocking dialog can consume the user-gesture/transient
      // activation the Share API requires, which would silently break a share that otherwise
      // would have worked.)
      const fallbackText = buildFallbackText();
      let shared = false;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'AbaPay Receipt', text: fallbackText });
          shared = true; // the OS share sheet opening is itself the visible confirmation
        } catch (shareErr: any) {
          if (shareErr?.name === 'AbortError') return; // user closed the sheet themselves
        }
      }
      if (!shared) {
        try {
          await navigator.clipboard.writeText(fallbackText);
          alert("Couldn't generate a receipt image, so the details were copied to your clipboard instead.");
        } catch (clipboardErr) {
          // Absolute last resort — neither Share nor Clipboard worked. Guarantee something
          // visible rather than the silent nothing this used to end in.
          alert(`Couldn't generate or share a receipt image.\n\n${fallbackText}`);
        }
      }
    } finally {
      setIsProcessingShare(false);
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

             {/* ⚡ SAVE FALLBACK — shown when the webview can't open a native file share sheet
                  (desktop, MiniPay, Base App, Farcaster, ...). These are REAL <a download>
                  links the user taps themselves, not a JS-synthesized click: a script-triggered
                  anchor click is exactly what several mobile webviews were silently treating as
                  a plain navigation instead of a download — dumping the user out of the whole
                  app onto a bare blob: URL with no save option. A genuine tap doesn't hit that
                  restriction.
                  Deliberately no target="_blank": a wallet's embedded browser routes new-tab
                  navigation through its own native URI dispatcher, which can't resolve these
                  self-contained data: URLs any better than it could the blob: URLs from the
                  attempt before this one ("Can not handle uri:: blob:..." / same failure class
                  for data:) — same-tab keeps the whole thing inside the browser engine itself.
                  The image preview below is shown unconditionally alongside them (not gated
                  behind a "download failed" check, which we have no reliable way to detect) so
                  there's always at least one guaranteed-working path: long-press. */}
             {saveOptions && (
                <div data-html2canvas-ignore="true" className="mb-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80">
                   <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 text-center mb-2">Save your receipt</p>
                   <div className="flex gap-2 mb-3">
                      <a
                        href={saveOptions.imageUrl}
                        download={`AbaPay_Receipt_${receipt.id}.png`}
                        rel="noopener"
                        className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"
                      >
                         <Download size={14}/> Image
                      </a>
                      {saveOptions.pdfUrl && (
                        <a
                          href={saveOptions.pdfUrl}
                          download={`AbaPay_Receipt_${receipt.id}.pdf`}
                          rel="noopener"
                          className="flex-1 py-3 bg-slate-800 dark:bg-white hover:bg-slate-700 dark:hover:bg-slate-200 text-white dark:text-slate-900 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"
                        >
                           <Download size={14}/> PDF
                        </a>
                      )}
                   </div>

                   <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 text-center mb-2">Or long-press the image to save it</p>
                   {/* eslint-disable-next-line @next/next/no-img-element */}
                   <img src={saveOptions.imageUrl} alt="AbaPay receipt" className="w-full rounded-xl border border-slate-200 dark:border-slate-700" />
                   <button onClick={() => setSaveOptions(null)} className="mt-2 w-full py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                      Done
                   </button>
                </div>
             )}

             <div className="flex gap-2">
                <button 
                  data-html2canvas-ignore="true"
                  onClick={handleShareImage} 
                  disabled={isProcessingShare}
                  className="flex-1 py-4 bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-200 text-white dark:text-slate-900 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95 shadow-xl shadow-slate-900/20 dark:shadow-white/10 disabled:opacity-60"
                >
                  {isProcessingShare ? (<><Loader2 size={16} className="animate-spin"/> PREPARING…</>) : (<><Share2 size={16}/> SHARE</>)}
                </button>
                {receipt.status !== 'SUCCESS' && receipt.status !== 'REFUNDED' && (
                   <button data-html2canvas-ignore="true" onClick={onSupport} className="flex-1 py-4 bg-orange-100 dark:bg-orange-900/20 hover:bg-orange-200 dark:hover:bg-orange-900/40 text-orange-700 dark:text-orange-400 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"><HelpCircle size={16}/> Support</button>
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
                   {/* ⚡ VTpass ships a flag URL with every country it supports — prefer its own
                       artwork (same reason the provider pickers use VTpass's product images),
                       and keep flagcdn as the fallback for the local "NG" entry, which is not
                       part of VTpass's international catalogue and so carries no flag. */}
                   <img
                     src={country.flag || `https://flagcdn.com/w40/${country.code.toLowerCase()}.png`}
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