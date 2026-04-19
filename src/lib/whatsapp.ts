export async function sendWhatsAppOTP(phone: string, otpCode: string): Promise<boolean> {
    try {
        // 🚨 PLACEHOLDER FOR FUTURE META/TWILIO API 🚨
        console.log(`\n========================================`);
        console.log(`📲 MOCK WHATSAPP SENT TO: ${phone}`);
        console.log(`🔢 YOUR ABAPAY VERIFICATION CODE: ${otpCode}`);
        console.log(`========================================\n`);

        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 800));
        return true; 
    } catch (error) {
        console.error("Failed to send WhatsApp OTP:", error);
        return false;
    }
}
