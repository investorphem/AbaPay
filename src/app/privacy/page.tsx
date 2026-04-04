export default function PrivacyPolicy() {
  return (
    <div className="max-w-2xl mx-auto p-6 text-gray-800 leading-relaxed">
      <h1 className="text-2xl font-bold mb-4">Privacy Policy</h1>
      <p className="text-sm mb-6 text-gray-500">Last updated: April 4, 2026</p>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">1. Introduction</h2>
        <p>AbaPay ("we", "us", or "our") is committed to protecting your privacy. This policy explains how we handle data when you use our bill payment service.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">2. Data We Collect</h2>
        <ul className="list-bullet pl-5 space-y-1">
          <li><strong>Wallet Address:</strong> We use your public Celo wallet address to facilitate transactions.</li>
          <li><strong>Transaction History:</strong> We store metadata (amount, token type, and bills paid) to provide you with a payment history.</li>
          <li><strong>No Private Keys:</strong> We NEVER collect, store, or have access to your private keys or seed phrases.</li>
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">3. How We Use Data</h2>
        <p>Your data is used solely to process your bill payments (Airtime, Data, Electricity) and to display your transaction history within the app.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">4. Third-Party Services</h2>
        <p>We interact with the Celo Blockchain and relevant Nigerian utility providers to fulfill your orders. These entities have their own privacy policies.</p>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">5. Contact Us</h2>
        <p>For any privacy concerns, contact us via our Telegram support channel.</p>
      </section>
    </div>
  );
}