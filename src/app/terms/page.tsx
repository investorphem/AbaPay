export default function TermsOfService() {
  return (
    <div className="max-w-2xl mx-auto p-6 text-gray-800 leading-relaxed">
      <h1 className="text-2xl font-bold mb-4">Terms of Service</h1>
      <p className="text-sm mb-6 text-gray-500">Last updated: April 4, 2026</p>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">1. Description of Service</h2>
        <p>AbaPay is a decentralized utility platform that allows users to pay Nigerian bills using stablecoins (USDT/USDC) on the Celo blockchain.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">2. User Responsibility</h2>
        <p>You are responsible for ensuring the accuracy of the phone numbers or account numbers provided for bill payments. Transactions on the blockchain are irreversible.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">3. Fees</h2>
        <p>AbaPay may charge a small service fee per transaction. These fees are displayed clearly before you confirm a payment.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">4. Limitation of Liability</h2>
        <p>AbaPay is a software interface. We are not responsible for blockchain network congestion, smart contract exploits, or errors made by third-party utility providers.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">5. Governing Law</h2>
        <p>These terms are governed by the laws of the Federal Republic of Nigeria.</p>
      </section>
    </div>
  );
}