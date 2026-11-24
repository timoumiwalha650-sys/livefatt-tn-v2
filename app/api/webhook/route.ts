import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

type ChatTurn = {
  role: "user" | "assistant";
  text: string;
};

const MARIAM_PERSONA = `أنتِ "مريم"، مساعدة خدمة العملاء لصفحة "The Viral Creature" في تونس.
قواعدكِ الثابتة:
1. لهجة تونسية مهنية وواضحة فقط:
- استعملي حرف النون للمتكلم في المضارع: (نعاونك، نثبّتلك، نشوفلك، نرجعلك). لا تقولي (أساعدك، أقولك، أبعتلك).
- استعملي: (صباط / سبادري، في الصفحة، تنجم، شنوّة، مرحبا بك، يعطيك الصحة).
- لا تقولي أبداً: (حذاء، بالصفحة، عشان، عيوني، إيه، أبشر، يا هلا فيك).
- إذا كتب الزبون بالفرنسية أو الإنجليزية، ردي بنفس لغته باختصار ولباقة.
2. تسلسل المحادثة:
- اقرئي الرسائل السابقة في نفس المحادثة ولا تكرري الترحيب في كل رد.
3. الدقة ومنع التخريف:
- لا تخترعي أسعاراً، مواعيد توصيل، أو توفر منتجات غير مؤكدة. إذا لم يكن واضحاً أو مؤكداً، وضّحي بلطف أنكِ ستثبّتين وتُعلمينه، واسألي سؤالاً قصيراً واحداً.`;

const processedMessageIds = new Map<string, number>();
const sessionHistory = new Map<string, ChatTurn[]>();

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

function cleanModel(raw?: string): string {
  if (!raw) return "";
  return raw.replace(/^models\//i, "").trim();
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

function getHistory(senderId: string): ChatTurn[] {
  return sessionHistory.get(senderId) || [];
}

function saveTurn(senderId: string, turn: ChatTurn) {
  const current = sessionHistory.get(senderId) || [];
  sessionHistory.set(senderId, [...current, turn].slice(-8));
}

async function callGeminiOnce(
  apiKey: string,
  model: string,
  history: ChatTurn[],
  currentUserText: string,
  timeoutMs = 5000
) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const historyText =
    history.length > 0
      ? history.map((t) => `${t.role === "user" ? "الزبون" : "مريم"}: ${t.text}`).join("\n")
      : "بداية المحادثة.";

  const prompt = `${MARIAM_PERSONA}\n\nالمحادثة السابقة:\n${historyText}\n\nالرسالة الجديدة من الزبون:\n${currentUserText}\n\nرد مريم:`;
  const t0 = Date.now();

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
          temperature: 0.2,
          maxOutputTokens: 200,
        },
      }),
    });

    const textBody = await res.text();
    console.log(
      JSON.stringify({ ev: "gemini", model, status: res.status, ms: Date.now() - t0 })
    );
    return { ok: res.ok, status: res.status, textBody };
  } catch (err: any) {
    console.log(
      JSON.stringify({ ev: "gemini", model, err: err?.name || "Error", ms: Date.now() - t0 })
    );
    return { ok: false, status: 504, textBody: err?.message || "Timeout" };
  }
}

async function generateMariamReply(senderId: string, userText: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("DEBUG: GEMINI_API_KEY is missing");
    return "مرحبا بك! وصلتنا رسالتك وتَو نرجعولك في أقرب وقت.";
  }

  const history = getHistory(senderId);
  const configured = cleanModel(process.env.GEMINI_MODEL);
  const candidates = Array.from(
    new Set(["gemini-3.5-flash-lite", configured, "gemini-3.8-flash-lite"].filter(Boolean))
  ).slice(0, 2);

  for (const model of candidates) {
    const attempt = await callGeminiOnce(apiKey, model, history, userText, 5000);
    if (attempt.ok) {
      try {
        const data: any = JSON.parse(attempt.textBody);
        const replyText =
          data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text ?? "")
            .join("")
            .trim() || "";
        if (replyText) {
          saveTurn(senderId, { role: "user", text: userText });
          saveTurn(senderId, { role: "assistant", text: replyText });
          return replyText;
        }
      } catch (e) {
        console.error("DEBUG: Failed parsing Gemini JSON:", e);
      }
    }
  }

  return "فمّا ضغط صغير تَو، عاود ابعث رسالتك وتَو نجاوبك في الحين.";
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
      signal: AbortSignal.timeout(5000),
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
          const reply = await generateMariamReply(String(senderId), text.trim());
          await sendMessage(String(senderId), reply);
        }
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
