import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

type ChatTurn = {
  role: "user" | "assistant";
  text: string;
};

const MARIAM_PERSONA = `أنتِ "مريم"، مساعدة خدمة العملاء والتواصل لصفحة "The Viral Creature" في تونس.
تتحدثين مع الزبون كإنسانة تونسية حقيقية، ذكية، قريبة، ومحترفة، وتربطين كل رسائله السابقة ببعضها.

1. قواعد اللهجة التونسية الصارمة (إلزامية 100%):
- اكتبِي باللهجة التونسية المحترفة والطبيعية فقط.
- قاعدة النون في المضارع للمتكلم: استعملي دائماً حرف النون في الفعل المضارع للمتكلم: ("نعاونك"، "نثبّتلك"، "نجيبلك"، "نعطيك"، "نشوفلك"، "نرجعلك"). يُمنع تماماً استعمال الهمزة مثل ("أساعدك"، "أجيبلك"، "أعطيك").
- استعملي المفردات التونسية الأصيلة:
  * نقول "صباط" أو "سبادري" (وليس "حذاء").
  * نقول "في الصفحة" (وليس "بالصفحة").
  * نقول "لو تنجم" أو "تنجم" (وليس "لو تقدر").
  * نقول "باش" (وليس "عشان").
  * نقول "شنوّة" (وليس "إيش" أو "شو").
  * نقول "حاضر" أو "بكل سرور" أو "مرحبا بك" (يُمنع تماماً: "عيوني"، "أبشر"، "يا هلا فيك"، "بتلبق"، "دلوقتي"، "حاجة").
- التناسق النحوي التونسي: نقول "اللي شفتو في الصفحة" أو "اللي شفتيه في الصفحة" (وليس "معين شفناه").
- إذا كتب الزبون بالفرنسية أو الإنجليزية، ردي بنفس لغته بأسلوب مهذب ومختصر.

2. قواعد ربط المحادثة والذاكرة:
- اقرئي سجل المحادثة السابق بعناية واربطي كل رسائل الزبون ببعضها (مثلاً: إذا سأل عن السوم، ثم قال "صباط نايك"، ثم قال "اللي لونو أكحل/أسود"، فافهمي فوراً أنه يقصد سوم الصباط النايك الأسود ولا تسأليه من جديد عن نوع المنتج!).
- لا تكرري الترحيب ("مرحبا بك" / "أهلاً بك") في كل رسالة؛ رحّبي في بداية المحادثة فقط، وفي الردود التالية ادخلي مباشرة في الجواب بذكاء وسلاسة.

3. قواعد الدقة ومنع التخريف:
- لا تخترعي أبداً أسعاراً، عروضاً، مواعيد توصيل، أو مقاسات غير مؤكدة.
- كوني مختصرة، واضحة، وطبيعية جداً.

أمثلة على أسلوبكِ التونسي الصحيح:
- الزبون: "السوم بربي" -> مريم: "مرحبا بك! يعطيك الصحة على سؤالك. على أنا منتج بالضبط تحب تعرف السوم؟"
- الزبون: "الصباط النايك" -> مريم: "فهمتك، قصدك على الصباط النايك اللي في الصفحة. لو تنجم تبعثلي تصورتو أو تقلي أما لون بالضبط باش نثبّتلك في سومو وتفاصيلو ونرجعلك."
- الزبون: "اللي لونو اسود" -> مريم: "واضح، الصباط النايك الأسود. تَو نثبّتلك في سومو الدقيق والـ pointures المتوفرة ونرجعلك في أقرب وقت."`;

const processedMessageIds = new Map<string, number>();
const localMemory = new Map<string, ChatTurn[]>();

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

async function fetchConversationHistory(senderId: string): Promise<ChatTurn[]> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    return localMemory.get(senderId) || [];
  }

  try {
    const url = `https://graph.facebook.com/v21.0/me/conversations?platform=messenger&user_id=${encodeURIComponent(
      senderId
    )}&fields=messages.limit(8){message,from,created_time}&access_token=${encodeURIComponent(
      token
    )}`;

    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(2500),
    });

    if (!res.ok) {
      return localMemory.get(senderId) || [];
    }

    const data: any = await res.json();
    const rawMessages = data?.data?.[0]?.messages?.data;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return localMemory.get(senderId) || [];
    }

    const turns: ChatTurn[] = rawMessages
      .slice()
      .reverse()
      .filter((m: any) => typeof m?.message === "string" && m.message.trim().length > 0)
      .map((m: any) => ({
        role: m?.from?.id === senderId ? "user" : "assistant",
        text: m.message.trim(),
      }));

    if (turns.length > 0) {
      localMemory.set(senderId, turns);
      return turns;
    }
  } catch {
    // Fallback to in-memory history if Graph API conversation fetch times out
  }

  return localMemory.get(senderId) || [];
}

function appendLocalTurn(senderId: string, turn: ChatTurn) {
  const existing = localMemory.get(senderId) || [];
  const updated = [...existing, turn].slice(-10);
  localMemory.set(senderId, updated);
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

  const formattedHistory =
    history.length > 0
      ? history
          .map((t) => `${t.role === "user" ? "الزبون" : "مريم"}: ${t.text}`)
          .join("\n")
      : "لا توجد رسائل سابقة (هذه أول رسالة في المحادثة).";

  const prompt = `${MARIAM_PERSONA}\n\nسجل المحادثة السابق مع هذا الزبون:\n${formattedHistory}\n\nالرسالة الحالية من الزبون:\n${currentUserText}\n\nرد مريم (بالتونسي المحترف ومباشرة في السياق):`;
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
          temperature: 0.45,
          maxOutputTokens: 250,
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

  const history = await fetchConversationHistory(senderId);
  const trimmedHistory =
    history.length > 0 && history[history.length - 1].text === userText
      ? history.slice(0, -1)
      : history;

  const configured = cleanModel(process.env.GEMINI_MODEL);
  const candidates = Array.from(
    new Set(["gemini-3.5-flash-lite", configured, "gemini-3.8-flash-lite"].filter(Boolean))
  ).slice(0, 2);

  for (const model of candidates) {
    const attempt = await callGeminiOnce(apiKey, model, trimmedHistory, userText, 5000);
    if (attempt.ok) {
      try {
        const data: any = JSON.parse(attempt.textBody);
        const replyText =
          data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text ?? "")
            .join("")
            .trim() || "";
        if (replyText) {
          appendLocalTurn(senderId, { role: "user", text: userText });
          appendLocalTurn(senderId, { role: "assistant", text: replyText });
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
