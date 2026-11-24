import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

const MARIAM_PERSONA = `أنتِ "مريم"، مساعدة خدمة العملاء والتواصل لصفحة "The Viral Creature".
أسلوبكِ بشري، دافئ، طبيعي، واضح، ومرن — بعيد تماماً عن الجمود أو الردود الآلية المكررة.
- افهمي قصد العميل من سؤاله أو رسالته (سواء سأل عن السعر، التفاصيل، التوفر، الطلب، أو ألقى تحية).
- ردي بنفس لغة العميل وأسلوبه المريح والواضح، مع الحفاظ على الاحترافية واللباقة.
- كوني مختصرة وواضحة دون حشو زائد أو تكرار، واطرحي سؤالاً ذكياً واحداً عند الحاجة لمساعدة العميل على إتمام ما يريد.
- إذا سأل العميل عن معلومة غير مذكورة لديكِ حالياً (مثل سعر أو تفصيل محدد)، وضّحي له بلطف أنكِ ستؤكدينها له ولا تخترعي أرقاماً أو وعوداً غير مؤكدة.`;

const processedMessageIds = new Map<string, number>();

function isDuplicateMessage(mid?: string): boolean {
  if (!mid) return false;
  const now = Date.now();
  for (const [key, ts] of processedMessageIds.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      processedMessageIds.delete(key);
    }
  }
  if (processedMessageIds.has(mid)) {
    return true;
  }
  processedMessageIds.set(mid, now);
  return false;
}

function normalizeModelName(rawModel?: string): string {
  if (!rawModel) return "gemini-3.8-flash";
  const cleaned = rawModel.replace(/^models\//i, "").trim().toLowerCase();
  if (!cleaned || cleaned === "gemini-3.8-flash-lite" || cleaned === "gemini-2.5-flash" || cleaned === "gemini-2.0-flash") {
    return "gemini-3.8-flash";
  }
  return cleaned;
}

function verifySignature(rawBody: string, sigHeader: string | null): boolean {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) {
    return true;
  }
  if (!sigHeader || !sigHeader.startsWith("sha256=")) {
    return false;
  }
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function callGeminiOnce(apiKey: string, model: string, userText: string, timeoutMs = 12000) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = `${MARIAM_PERSONA}\n\nرسالة العميل:\n${userText}\n\nرد مريم:`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.75,
          maxOutputTokens: 220,
        },
      }),
    });

    const textBody = await res.text();
    return { ok: res.ok, status: res.status, textBody };
  } catch (err: any) {
    return { ok: false, status: 504, textBody: err?.message || "The operation was aborted due to timeout" };
  }
}

async function generateMariamReply(userText: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = normalizeModelName(process.env.GEMINI_MODEL);

  if (!apiKey) {
    console.error("DEBUG: GEMINI_API_KEY is missing");
    return "أهلاً بكِ! وصلتني رسالتك وسنرد عليكِ في أقرب وقت.";
  }

  const attempt = await callGeminiOnce(apiKey, model, userText, 12000);
  if (attempt.ok) {
    try {
      const data: any = JSON.parse(attempt.textBody);
      const replyText =
        data?.candidates?.[0]?.content?.parts
          ?.map((p: any) => p?.text ?? "")
          .join("")
          .trim() || "";
      if (replyText) {
        return replyText;
      }
    } catch (e) {
      console.error("DEBUG: Failed parsing Gemini JSON:", e);
    }
  } else {
    console.error(`DEBUG: Gemini API error (${model}) status ${attempt.status}: ${attempt.textBody}`);
  }

  return "أهلاً بكِ! واجهنا ضغطاً مؤقتاً الآن، أعيدي إرسال سؤالك وسأجيبكِ فوراً.";
}

async function sendMessage(recipientId: string, text: string) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error("DEBUG: FB_PAGE_ACCESS_TOKEN is missing");
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    }
  );

  const data = await res.text();
  console.log("DEBUG: Graph API send status:", res.status, "response:", data);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.FB_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("x-hub-signature-256");

  if (!verifySignature(rawBody, sigHeader)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body?.object === "page" && Array.isArray(body?.entry)) {
    for (const entry of body.entry) {
      const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];

      for (const ev of messaging) {
        if (ev?.message?.is_echo) {
          continue;
        }
        const mid = typeof ev?.message?.mid === "string" ? ev.message.mid : undefined;
        if (isDuplicateMessage(mid)) {
          continue;
        }

        const senderId = ev?.sender?.id;
        const text = ev?.message?.text;

        if (senderId && typeof text === "string" && text.trim().length > 0) {
          const reply = await generateMariamReply(text.trim());
          await sendMessage(String(senderId), reply);
        }
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
