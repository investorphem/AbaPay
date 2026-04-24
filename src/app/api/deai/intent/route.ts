import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize the Gemini Client
// Make sure to add GEMINI_API_KEY to your .env.local file
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

export async function POST(req: Request) {
  try {
    const { message } = await req.json();

    if (!message) {
      return NextResponse.json({ success: false, message: "Message is required" }, { status: 400 });
    }

    // We use Gemini 1.5 Flash because it is insanely fast and cost-effective for routing
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        // THIS is the magic rule. It completely disables conversational text.
        responseMimeType: "application/json",
      }
    });

    // The Prompt: We act as a strict compiler instructing the AI
    const prompt = `
      You are the core intent routing engine for AbaPay, a Web3 utility app.
      Your job is to read the user's text message and extract the exact transaction details.
      
      Return ONLY a valid JSON object matching this exact TypeScript interface:
      {
        "intent": "VEND_AIRTIME" | "VEND_DATA" | "PAY_ELECTRICITY" | "UNKNOWN",
        "provider": "MTN" | "AIRTEL" | "GLO" | "9MOBILE" | "IKEJA_ELECTRIC" | null,
        "amount_ngn": number | null,
        "destination_account": string | null,
        "confidence_score": number (from 0.0 to 1.0)
      }

      Rules:
      1. If the user uses slang like "2k", convert it to the number 2000.
      2. If you cannot confidently determine the provider or amount, set them to null.
      3. The destination_account is the phone number or meter number.

      User Message: "${message}"
    `;

    // Execute the AI processing
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Parse the strict JSON string back into a JavaScript object
    const intentData = JSON.parse(responseText);

    // Return the clean data to your application logic
    return NextResponse.json({ 
      success: true, 
      data: intentData 
    });

  } catch (error) {
    console.error("DeAI Parsing Error:", error);
    return NextResponse.json({ success: false, message: "Failed to process AI intent" }, { status: 500 });
  }
}
