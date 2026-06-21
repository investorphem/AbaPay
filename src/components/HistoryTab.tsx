import { Receipt, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";

export function HistoryTab({ transactions, currentTransactions, currentPage, totalPages, setCurrentPage, setSelectedReceipt }: any) {
  return (
    <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-6 shadow-2xl dark:shadow-black/50 animate-in slide-in-from-bottom-4 transition-colors">
       {transactions.length === 0 ? (
          <div className="py-24 text-center">
              <div className="bg-slate-100 dark:bg-slate-800/50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
                  <Receipt size={40} className="text-slate-300 dark:text-slate-600" />
              </div>
              <p className="text-slate-400 dark:text-slate-500 text-xs font-black uppercase tracking-widest">No transaction activity found</p>
          </div>
       ) : (

                  return (
                      <div key={idx} onClick={() => setSelectedReceipt(tx)} className="p-5 bg-slate-50 dark:bg-[#1a1a1f] rounded-2xl border border-slate-100 dark:border-slate-800/80 flex justify-between items-center cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:border-emerald-100 dark:hover:border-emerald-900/50 transition-all group shadow-sm active:scale-[0.98]">
                          <div>
                              <p className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors tracking-tight line-clamp-1">{tx.network} {tx.service}</p>
                              <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                {/* ⚡ MULTI-CHAIN BADGE ⚡ */}
                                <span className={`font-black uppercase tracking-widest ${isBaseTx ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-500 dark:text-emerald-400'}`}>
                                  {tx.blockchain || 'CELO'}
                                </span>
                                <span>•</span>
                                <span>{tx.date}</span>
                                <span>•</span>
                                <span className={tx.status === 'SUCCESS' ? 'text-emerald-600 dark:text-emerald-500 font-bold' : tx.status === 'REFUNDED' ? 'text-blue-500 dark:text-blue-400 font-bold' : 'text-red-500 dark:text-red-400 font-bold'}>{tx.status}</span>
                                <span>•</span>
                                <span className="font-mono text-slate-400 dark:text-slate-500">{tx.account}</span>
                              </p>
                          </div>
                          <div className="text-right flex flex-col items-end gap-1.5 shrink-0 ml-2">
                              <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">₦{Number(tx.amountNaira).toLocaleString()}</p>
                              <span className="text-[9px] font-black uppercase tracking-widest bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-3 py-1 rounded-full group-hover:bg-emerald-200 dark:group-hover:bg-emerald-900/40 group-hover:text-emerald-800 dark:group-hover:text-emerald-300 transition-all flex items-center gap-1">
                                Receipt <ExternalLink size={10}/>
                              </span>
                          </div>
                      </div>
                  );
              })}

              {totalPages > 1 && (
                <div className="flex justify-between items-center mt-6 pt-5 border-t border-slate-100 dark:border-slate-800/60 transition-colors">
                  <button onClick={() => setCurrentPage((p: number) => Math.max(1, p - 1))} disabled={currentPage === 1} className="flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 dark:bg-slate-800/50 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-30 transition-all">
                    <ChevronLeft size={16} /> Prev
                  </button>
                  <span className="text-[10px] font-black tracking-widest text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800/50 px-3 py-1.5 rounded-full">PAGE {currentPage} OF {totalPages}</span>
                  <button onClick={() => setCurrentPage((p: number) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 dark:bg-slate-800/50 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-30 transition-all">
                    Next <ChevronRight size={16} />
                  </button>
                </div>
              )}
          </div>
       )}
    </div>
  );
}