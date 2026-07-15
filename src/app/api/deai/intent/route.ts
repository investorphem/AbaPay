import { NextResponse } from 'next/server';
import { verifyInternalRequest } from '@/utils/internalAuth';
import { parseIntent } from '@/lib/deai/intentEngine';

// ⚡ DeAI INTENT ROUTE — now powered by Claude (was Gemini).
// The actual model call lives in src/lib/deai/intentEngine.ts so the core brain can also
// call it directly without an HTTP hop.

export async function POST(req: Request) {
  try {
    // 🔐 INTERNAL ONLY: stops the public internet burning our AI budget through this endpoint.
    if (!verifyInternalRequest(req)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { message } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ success: false, message: "Message is required" }, { status: 400 });
    }

    // 🔐 ABUSE CONTROL: cap input size to limit AI cost abuse and prompt-injection surface.
    if (message.length > 500) {
      return NextResponse.json({ success: false, message: "Message too long (max 500 characters)" }, { status: 400 });
    }

    const data = await parseIntent(message);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("DeAI Parsing Error:", error);
    return NextResponse.json({ success: false, message: "Failed to process AI intent" }, { status: 500 });
  }
}
