import React from 'react';
import { ChevronDown, Coins, Loader2, Landmark, CheckCircle2, XCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { SUPPORTED_TOKENS } from "@/constants";

export default function BankTab({
  selectedToken, setSelectedToken, walletBalance, walletBalanceNaira, isFetchingBalance,
  bankVariations, selectedBank, handleProviderChange, accountNumber, setAccountNumber,
  isVerifying, beneficiaries, getCurrentProviderKey, activeDeleteAccount, setActiveDeleteAccount,
  removeBeneficiary, setCustomerName, customerName, dynamicMinAmount, dynamicMaxAmount,
  nairaAmount, setNairaAmount, cryptoToCharge, currentFee, customerPhone, setCustomerPhone,
  customerEmail, setCustomerEmail, status, setIsConfirmModalOpen, isFormValid, isProcessing,
  openSelectionModal, pressTimer, isLongPress
}: any) {

  return (
    <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
        <div className="space-y-5">
            <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
              <div 
                className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 p-2 -ml-2 rounded-xl transition-colors" 
                onClick={() => openSelectionModal('token', "Select Token", SUPPORTED_TOKENS, (symbol: string) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
              >
                 <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 object-contain rounded-full shadow-sm bg-white" />
                 <span className="font-black text-slate-800 uppercase text-sm tracking-tight">{selectedToken.symbol}</span>
                 <ChevronDown size={14} className="text-slate-400"/>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Balance</p>
                <div className="flex items-center justify-end gap-1.5">
                  {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500"/> : <Coins size={14} className="text-emerald-500"/>}
                  <div className="flex flex-col items-end">
                    <p className="font-mono font-black text-sm text-slate-800 leading-none">{walletBalance}</p>
                    {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 mt-1 tracking-tight">≈ ₦{walletBalanceNaira}</p>}
                  </div>
                </div>
              </div>
            </div>

            <div className="animate-in slide-in-from-left-2 mb-2">
                <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">Bank</label>
                <button 
                    onClick={() => openSelectionModal('bank', "Select Destination Bank", bankVariations, (val: any) => {
                        const foundBank = bankVariations.find((b: any) => b.variation_code === val);
                        handleProviderChange(foundBank, 'bank');
                    })}
                    className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-blue-400 transition-colors shadow-sm active:scale-[0.98]"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-blue-50 flex items-center justify-center shadow-inner">
                            <Landmark className="text-blue-500" size={20} />
                        </div>
                        <span className="text-sm font-black text-slate-900 tracking-tight">{selectedBank ? selectedBank.name : 'Select Bank'}</span>
                    </div>
                    <ChevronDown size={18} className="text-slate-400"/>
                </button>
            </div>

            <div>
                <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                  <span>Account No</span>
                  <span className={accountNumber.length === 10 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/10</span>
                </label>
                <input 
                    type="tel" placeholder="1234567890"
                    maxLength={10}
                    className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                      accountNumber.length > 0 && accountNumber.length < 10 ? "border-red-300" : "border-slate-100 focus:border-emerald-500"
                    }`}
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                />
                {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}

                {(() => {
                    const key = getCurrentProviderKey();
                    const list = key ? beneficiaries[key] : [];
                    if (!list || list.length === 0) return null;
                    return (
                        <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                            <span className="text-[9px] font-black uppercase text-slate-400 shrink-0">Recent:</span>
                            {list.map((ben: any, idx: number) => (
                                <button 
                                    key={idx}
                                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                    style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                                    onTouchStart={() => {
                                        isLongPress.current = false;
                                        pressTimer.current = setTimeout(() => {
                                            isLongPress.current = true;
                                            setActiveDeleteAccount(ben.account);
                                            if (navigator.vibrate) navigator.vibrate(50);
                                            setTimeout(() => setActiveDeleteAccount(null), 4000);
                                        }, 500); 
                                    }}
                                    onTouchEnd={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                    onTouchMove={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                    onMouseDown={() => {
                                        isLongPress.current = false;
                                        pressTimer.current = setTimeout(() => {
                                            isLongPress.current = true;
                                            setActiveDeleteAccount(ben.account);
                                            setTimeout(() => setActiveDeleteAccount(null), 4000);
                                        }, 500); 
                                    }}
                                    onMouseUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                    onMouseLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        if (isLongPress.current) {
                                            isLongPress.current = false;
                                            return;
                                        }
                                        if (activeDeleteAccount === ben.account) {
                                            removeBeneficiary(ben.account);
                                            setActiveDeleteAccount(null);
                                        } else {
                                            setAccountNumber(ben.account);
                                            if (ben.name) setCustomerName(ben.name);
                                            setActiveDeleteAccount(null); 
                                        }
                                    }}
                                    className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none ${
                                        activeDeleteAccount === ben.account 
                                        ? 'bg-red-50 text-red-600 border-red-200' 
                                        : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200' 
                                    }`}
                                >
                                    {activeDeleteAccount === ben.account ? (
                                        <><XCircle size={12} className="animate-pulse" /> Delete</>
                                    ) : (
                                        <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    );
                })()}

                {customerName && (
                    <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                        <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
                        <div className="flex-1">
                            <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                            <p className="text-[10px] font-black text-emerald-600 uppercase mt-0.5">Verified</p>
                        </div>
                    </div>
                )}
            </div>

            <div>
                <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                   <span>Amount</span>
                   <span className="text-emerald-500 font-black">MIN ₦{dynamicMinAmount.toLocaleString()}</span>
                </label>
                <div className="relative mb-3">
                    <input 
                        type="number" 
                        placeholder="Amount" 
                        className="w-full bg-slate-50 border border-slate-100 p-6 rounded-2xl font-black text-3xl text-slate-800 outline-none shadow-inner"
                        value={nairaAmount}
                        onChange={(e) => setNairaAmount(e.target.value)}
                    />
                    <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                        <p className="text-sm font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                        {currentFee > 0 && <p className="text-[9px] font-black text-orange-500">+₦{currentFee} FEE</p>}
                    </div>
                </div>
                {nairaAmount && (parseFloat(nairaAmount) < dynamicMinAmount || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                    <div className="bg-red-50 border border-red-200 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in">
                        <AlertTriangle size={16} className="text-red-500 shrink-0" />
                        <p className="text-xs font-black text-red-600">
                            {parseFloat(nairaAmount) < dynamicMinAmount ? `Amount is below the minimum of ₦${dynamicMinAmount.toLocaleString()}` : `Amount exceeds the maximum of ₦${dynamicMaxAmount.toLocaleString()}`}
                        </p>
                    </div>
                )}
            </div>

            <div className="animate-in fade-in">
                 <input 
                    type="tel" placeholder="Sender's Phone (Receipt)"
                    maxLength={11}
                    className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                />
            </div>

            <div className="animate-in fade-in mt-3">
                 <input 
                    type="email" placeholder="Email Address (Optional for Receipt)"
                    className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                />
            </div>

            {status && (
                <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in ${status.includes('Success') ? 'bg-emerald-50 border-emerald-100' : 'bg-blue-50 border-blue-100'}`}>
                    {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                    <p className="text-sm font-black tracking-tight">{status}</p>
                </div>
            )}

            <button 
                onClick={() => setIsConfirmModalOpen(true)}
                disabled={isVerifying || !isFormValid || isProcessing}
                className="w-full bg-slate-900 hover:bg-black text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
            >
                {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400"/> : <ShieldCheck size={24} className="text-emerald-400" />}
                {isProcessing ? 'PROCESSING...' : `TRANSFER ${cryptoToCharge} ${selectedToken.symbol}`}
            </button>
        </div>
      </div>
  );
}
