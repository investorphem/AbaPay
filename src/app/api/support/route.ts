import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const message = formData.get('message') as string;
    const file = formData.get('file') as File;
    const userAddress = formData.get('userAddress') as string;
    
    // UPGRADED: Catch the hidden transaction hash!
    const txHash = formData.get('txHash') as string; 

    // Mapping to your .env.local names
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
       console.error("[CRITICAL] Telegram keys missing in .env.local");
       return NextResponse.json({ success: false, message: "Server configuration error." }, { status: 500 });
    }

    // Professional Support Template (Now dynamically includes the Hash if it exists)
    const caption = `🎫 *ABAPAY SUPPORT TICKET*\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `👤 *Wallet:* \`${userAddress || 'Anonymous'}\`\n` +
                    (txHash ? `🔗 *TX ID:* \`${txHash}\`\n` : '') +
                    `💬 *Issue:* ${message}\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `⏰ *Time:* ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })} WAT`;

    let tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const tgFormData = new FormData();
    tgFormData.append('chat_id', chatId);
    tgFormData.append('parse_mode', 'Markdown'); // Makes the wallet and hash "tap to copy"

    // File Handling Logic
    if (file && file.size > 0) {
      // Use sendDocument to preserve image quality/PDF data
      tgUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
      tgFormData.append('document', file);
      tgFormData.append('caption', caption);
    } else {
      // Standard Text Message
      tgFormData.append('text', caption);
    }

    const tgResponse = await fetch(tgUrl, { 
        method: 'POST', 
        body: tgFormData 
    });

    if (!tgResponse.ok) {
        const errorData = await tgResponse.json();
        console.error("Telegram Error Details:", errorData);
        throw new Error("Telegram API rejected the payload.");
    }

    return NextResponse.json({ 
        success: true, 
        message: "Your ticket has been sent directly to the AbaPay Admin Team." 
    });

  } catch (error: any) {
    console.error("Support API Failure:", error.message);
    return NextResponse.json({ 
        success: false, 
        message: "Failed to dispatch ticket. Please try again or check your connection." 
    }, { status: 500 });
  }
}
