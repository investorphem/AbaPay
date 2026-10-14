// What a bill costs on top of its face value, in naira. One rule for every rail that prices a
// bill itself (/api/pay's contract rail and /api/pay/nim), so they can't drift apart.
//
//   • serviceFee: ₦100 where the bill needs a customer lookup first (electricity meters, bank
//     accounts, JAMB profiles, cable smartcards except Showmax) and on every education PIN.
//   • stampDutyNgn: CBN stamp duty, ₦50 on a bank transfer of ₦10,000 or more. A regulatory
//     pass-through, tracked in its own column (stamp_duty_ngn), not revenue.

export function billCharges(p: { serviceCategory?: string | null; serviceID?: string | null; network?: string | null; amountNgn: number }) {
  const { serviceCategory, serviceID, network, amountNgn } = p;
  const isForeign = serviceID === 'foreign-airtime';
  const needsVerification = !isForeign && (
    serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK'
    || (serviceCategory === 'EDUCATION' && serviceID === 'jamb')
    || (serviceCategory === 'CABLE' && network !== 'SHOWMAX')
  );
  const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
  const stampDutyNgn = (serviceCategory === 'BANK' && amountNgn >= 10000) ? 50 : 0;
  return { serviceFee, stampDutyNgn };
}
