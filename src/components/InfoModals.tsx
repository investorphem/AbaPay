import { XCircle } from "lucide-react";

export function TermsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
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

export function PrivacyModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
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
             <p>As a decentralized application, AbaPay does not require you to create an account or provide personal KYC information. We only collect the data necessary to fulfill your utility order (e.g., Meter Number, Phone Number).</p>
             <p className="font-bold text-slate-800 mt-4">2. Wallet Addresses</p>
             <p>Your connected Celo wallet address is recorded on the public blockchain when executing a transaction. This is a fundamental property of Web3 and is not hidden.</p>
             <p className="font-bold text-slate-800 mt-4">3. Third-Party Services</p>
             <p>Utility numbers provided (like phone or meter numbers) are securely passed to our fiat vending partners solely for the purpose of delivering your purchased service.</p>
          </div>
       </div>
    </div>
  );
}
