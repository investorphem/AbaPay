import 'server-only';

// ⚡ REMOVED TypeScript types (: string) so this works in a .js file
export const sendAbaPaySms = async (recipient, message) => {
  // ⚡ SMART SMS ROUTER: Prevent wasting real SMS credits during testing ⚡
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";

  if (appMode !== "live") {
    console.log(`💬 [SANDBOX SMS MOCKED] To: ${recipient} | Message: ${message}`);
    return { code: "000", message: "Sandbox SMS simulated successfully" };
  }

  const url = "s/dnd-fallback";

  const body = new URLSearchParams({
    sender: 'AbaPay',
    recipient: recipient,

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Token': process.env.VTPASS_MSG_TOKEN || "",
        'X-Secret': process.env.VTPASS_MSG_SECRET || "",
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    return await res.json();
  } catch (error) {
    console.error("SMS Failed:", error);
    return null;
  }
};