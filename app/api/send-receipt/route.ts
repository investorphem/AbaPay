import { Resend } from 'resend';
import { NextResponse } from 'next/server';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(request: Request) {
  try {
    const { userEmail, amount, txHash, serviceName, date } = await request.json();

    const data = await resend.emails.send({
      from: 'AbaPay Receipts <receipts@abapays.com>',
      to: [userEmail],
      subject: `Receipt for your AbaPay Transaction`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; padding: 40px 0; margin: 0;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
            
            <div style="background-color: #000000; padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">AbaPay</h1>
            </div>

            <div style="padding: 40px 30px;">
              <p style="margin: 0 0 10px; color: #52525b; font-size: 14px; text-transform: uppercase; font-weight: 600;">Transaction Successful</p>
              <h2 style="margin: 0 0 30px; color: #18181b; font-size: 32px;">${amount}</h2>
              
              <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Service</td>
                  <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500;">${serviceName}</td>
                </tr>
                <tr>
                  <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Date</td>
                  <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500;">${date}</td>
                </tr>
                <tr>
                  <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Transaction Hash / Ref</td>
                  <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500; word-break: break-all;">${txHash}</td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 0;">
                If you have any issues with this transaction, please reply directly to this email to reach our support desk.
              </p>
            </div>

            <div style="background-color: #f4f4f5; padding: 30px; text-align: center; border-top: 1px solid #e4e4e7;">
              <p style="color: #71717a; font-size: 14px; margin: 0 0 15px;">Join the AbaPay Community</p>
              
              <div>
                <a href="https://twitter.com/abapays" style="display: inline-block; margin: 0 10px; color: #000000; text-decoration: none; font-weight: 600; font-size: 14px;">X (Twitter)</a>
                <a href="https://t.me/abapays" style="display: inline-block; margin: 0 10px; color: #000000; text-decoration: none; font-weight: 600; font-size: 14px;">Telegram</a>
                <a href="https://wa.me/YourWhatsAppNumber" style="display: inline-block; margin: 0 10px; color: #000000; text-decoration: none; font-weight: 600; font-size: 14px;">WhatsApp</a>
              </div>
              
              <p style="color: #a1a1aa; font-size: 12px; margin: 20px 0 0;">
                &copy; 2026 Masonode Technologies Limited. All rights reserved.
              </p>
            </div>

          </div>
        </div>
      `,
    });

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error });
  }
}
