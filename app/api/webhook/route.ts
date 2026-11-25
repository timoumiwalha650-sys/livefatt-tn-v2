import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

type ChatTurn = {
  role: "user" | "assistant";
  text: string;
};

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60; // 2592000 ثانية = شهر كامل

const MARIAM_PERSONA = `أنتِ "مريم"، مساعدة خدمة العملاء لصفحة "The Viral Creature" في تونس.
تتحدثين بلهجة تونسية مهنية، واضحة، وطبيعية، وتتعاملين مع كل زبون كسجل متصل لمدة شهر (حتى لو عاد في نفس اللايف، في لايف مسجل لاحقاً، أو في محادثة أخرى).

1. الترحيب واللباقة:
- استعملي "مرحبا بك" أو "أهلاً بك" في أول تفاعل فقط عندما لا توجد رسائل أو تعليقات سابقة لهذا الزبون.
- في باقي التفاعلات، لا تكرري الترحيب عشوائياً؛ رحّبي أو أظهري لباقة فقط عند الشكر ("يعطيك الصحة" / "بلا مزية") أو عند ذكر الاسم ("تشرفنا بك [الاسم]") أو عند إتمام معطيات واضحة.

2. الذاكرة والسياق والرد على التعليقات والرسائل:
- اعتمدي على كامل سجل التفاعل المحفوظ لهذا الزبون (تعليقات البث المباشر أو المنشورات + رسائل Messenger).
- إذا عاد الزبون ليسأل عن شيء سأل عنه سابقاً أو عن اهتمامه أو مخزون منتج أو عاد بعد فترة في نفس اللايف أو في لايف مسجل:
  * استحضري ما سبق ذكره في السجل بدقة، واربطيه بسؤاله الحالي بذكاء ولباقة (ويمكن عرض بدائل أو منتجات مناسبة لاهتمامه دون اختلاق معلومات).
  * إذا لم يكن هناك سجل سابق أو لم يُذكر المنتج في السجل بعد، وضّحي ذلك ببساطة واطلبي التوضيح مباشرة.
- في تعليقات اللايف/المنشورات:
  * أجيبي تحت التعليق مباشرة لكل تعليق (سؤال عن منتج أو مخزون، اهتمام مؤجل، شكر، ذم، أو كلام خارج الموضوع) برد مهني، وافٍ، ومناسب للسياق، مع إمكانية استعمال إيموجي خفيف ومناسب.
  * لا تطلبي أو تكشفي معلومات شخصية (الاسم، العنوان، رقم الهاتف) في التعليقات العامة؛ وعندما يبدي الزبون جدية في الشراء أو يسأل بجدية عن منتج لإتمام الطلب، وجّهيه لإتمام تأكيد الطلب عبر Messenger بوضع الاسم والعنوان ورقم الهاتف.
- تجنبي استعمال عبارة "تَو نثبّتلك في النقطة هاذي ونرجعلك" كجملة مبهمة لا يتبعها رد لاحق تلقائي؛ إذا كانت المعلومة غير مؤكدة أو غير متوفرة حالياً، وضّحي ذلك بوضوح وقدّمي خطوة عملية واضحة (مثل تحديد الموديل، المقاس، اللون، أو التصويرة).
- لا تخترعي أسعاراً، مواعيد توصيل، أو توفراً غير مؤكد.

3. اللهجة التونسية:
- استعملي حرف النون للمتكلم في المضارع: (نعاونك، نثبّتلك، نشوفلك، نرجعلك). لا تقولي (أساعدك، أقولك، أبعتلك).
- استعملي: (في تونس، التوصيل، صباط، تصويرة، في الصفحة، شنوّة، تنجم، يعطيك الصحة).
- لا تقولي: (المغرب، الدليفرزي، عشان، عيوني، حذاء، بالصفحة، أبشر، يا هلا فيك، إيه).
- إذا كتب الزبون بالفرنسية أو الإنجليزية، ردي بنفس لغته باختصار ولباقة.`;

const memoryFallback = new Map<string, ChatTurn[]>();
const dedupFallback = new Map<string, number>();

function hasRedisConfig(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

async function redisCommand(command: (string | number)[]) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify(command),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(
        JSON.stringify({ ev: "redis_err", status: res.status, body: errText })
      );
      return null;
    }

    const data: any = await res.json();
    return data?.result ?? null;
  } catch (err: any) {
    console.log(
      JSON.stringify({ ev: "redis_timeout", err: err?.message || "Error" })
    );
    return null;
  }
}

async function isDuplicateEvent(key?: string): Promise<boolean> {
  if (!key) return false;
  const dedupKey = `livefatt:dedup:${key}`;

  if (hasRedisConfig()) {
    const setResult = await redisCommand(["SET", dedupKey, "1", "NX", "EX", 600]);
    if (setResult === "OK") {
      return false;
    }
    if (setResult === null) {
      // في حال تعذر الوصول إلى Redis مؤقتاً نستخدم ذاكرة احتياطية محلية لنفس الدالة
      const now = Date.now();
      const prev = dedupFallback.get(dedupKey);
      if (prev && now - prev < 10 * 60 * 1000) return true;
      dedupFallback.set(dedupKey, now);
      return false;
    }
    return true;
  }

  const now = Date.now();
  const prev = dedupFallback.get(dedupKey);
  if (prev && now - prev < 10 * 60 * 1000) return true;
  dedupFallback.set(dedupKey, now);
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

async function getCustomerHistory(personId: string): Promise<ChatTurn[]> {
  const historyKey = `livefatt:history:30d:${personId}`;

  if (hasRedisConfig()) {
    const raw = await redisCommand(["GET", historyKey]);
    if (typeof raw === "string" && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch (e) {
        console.error("DEBUG: Failed parsing Redis history:", e);
      }
    }
    if (Array.isArray(raw)) {
      return raw;
    }
  }

  return memoryFallback.get(personId) || [];
}

async function appendCustomerTurns(personId: string, turnsToAdd: ChatTurn[]) {
  if (turnsToAdd.length === 0) return;
  const historyKey = `livefatt:history:30d:${personId}`;
  const existing = await getCustomerHistory(personId);
  const updated = [...existing, ...turnsToAdd].slice(-50);

  memoryFallback.set(personId, updated);

  if (hasRedisConfig()) {
    await redisCommand([
      "SET",
      historyKey,
      JSON.stringify(updated),
      "EX",
      THIRTY_DAYS_SECONDS,
    ]);
  }
}

function hasForbiddenHallucination(text: string): boolean {
  const forbiddenPatterns = [
    /المغرب/i,
    /مغربي/i,
    /الدليفرزي/i,
    /عشان/i,
    /أقولك/i,
    /أبعتلك/i,
    /عيوني/i,
    /حذاء/i,
  ];
  return forbiddenPatterns.some((re) => re.test(text));
}

async function callGeminiOnce(
  apiKey: string,
  model: string,
  history: ChatTurn[],
  currentUserText: string,
  channelContext: string,
  timeoutMs = 5000
) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const isFirstTurn = history.length === 0;
  const historyText = isFirstTurn
    ? "لا توجد تفاعلات سابقة مسجلة لهذا الزبون خلال آخر 30 يوماً."
    : history
        .map((t) => `${t.role === "user" ? "الزبون" : "مريم"}: ${t.text}`)
        .join("\n");

  const prompt = `${MARIAM_PERSONA}

القناة الحالية: ${channelContext}
حالة السجل: ${isFirstTurn ? "أول تفاعل مسجل لهذا الزبون" : "تفاعل متصل مع سجل سابق محفوظ لمدة 30 يوماً"}
سجل التفاعل السابق مع الزبون:
${historyText}

الرسالة أو التعليق الحالي من الزبون:
${currentUserText}

رد مريم:`;

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
          temperature: 0.15,
          maxOutputTokens: 220,
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

async function generateMariamReply(
  personId: string,
  userText: string,
  channelContext: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const history = await getCustomerHistory(personId);
  const hasPriorTurns = history.length > 0;

  if (!apiKey) {
    console.error("DEBUG: GEMINI_API_KEY is missing");
    return hasPriorTurns
      ? "ما نجمتش نثبّت المعلومة توا؛ قلّي شنوة تحب تعرف بالضبط."
      : "مرحبا بك! وصلتنا رسالتك، قلّي شنوة تحب تعرف بالضبط.";
  }

  const configured = cleanModel(process.env.GEMINI_MODEL);
  const fallbackModel = cleanModel(process.env.GEMINI_FALLBACK_MODEL);
  const candidates = Array.from(
    new Set(
      [
        "gemini-3.5-flash-lite",
        configured,
        fallbackModel,
        "gemini-3.8-flash-lite",
      ].filter(Boolean)
    )
  ).slice(0, 3);

  for (const model of candidates) {
    const attempt = await callGeminiOnce(
      apiKey,
      model,
      history,
      userText,
      channelContext,
      5000
    );
    if (attempt.ok) {
      try {
        const data: any = JSON.parse(attempt.textBody);
        const replyText =
          data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text ?? "")
            .join("")
            .trim() || "";

        if (replyText && !hasForbiddenHallucination(replyText)) {
          await appendCustomerTurns(personId, [
            { role: "user", text: userText },
            { role: "assistant", text: replyText },
          ]);
          return replyText;
        }
        if (replyText && hasForbiddenHallucination(replyText)) {
          console.log(
            JSON.stringify({ ev: "blocked_hallucination", model, replyText })
          );
        }
      } catch (e) {
        console.error("DEBUG: Failed parsing Gemini JSON:", e);
      }
    }
  }

  await appendCustomerTurns(personId, [{ role: "user", text: userText }]);
  return hasPriorTurns
    ? "ما ظهرتليش المعلومة الكاملة توا؛ قلّي شنوة المنتج ولا السؤال اللي تقصدو."
    : "مرحبا بك! قلّي شنوة المنتج ولا السؤال اللي تحب تعرف عليه.";
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

async function sendCommentReply(commentId: string, message: string) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error("DEBUG: FB_PAGE_ACCESS_TOKEN is missing for comment reply");
    return;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(
        commentId
      )}/comments?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ message }),
      }
    );

    const data = await res.text();
    console.log("DEBUG: Graph API comment reply status:", res.status, "response:", data);
  } catch (err: any) {
    console.log(
      JSON.stringify({ ev: "comment_reply_err", commentId, err: err?.message || "Error" })
    );
  }
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
      const pageId = entry?.id ? String(entry.id) : "";
      const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];

      for (const ev of messaging) {
        if (ev?.message?.is_echo) {
          continue;
        }
        const mid = typeof ev?.message?.mid === "string" ? ev.message.mid : undefined;
        if (await isDuplicateEvent(mid ? `msg_${mid}` : undefined)) {
          continue;
        }

        const senderId = ev?.sender?.id;
        const text = ev?.message?.text;

        if (senderId && typeof text === "string" && text.trim().length > 0) {
          const reply = await generateMariamReply(
            String(senderId),
            text.trim(),
            "رسالة خاصة على Messenger"
          );
          await sendMessage(String(senderId), reply);
        }
      }

      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const ch of changes) {
        if (ch?.field !== "feed") {
          continue;
        }
        const val = ch?.value;
        if (!val || val?.item !== "comment" || val?.verb !== "add") {
          continue;
        }

        const commenterId = val?.from?.id ? String(val.from.id) : "";
        const commentId = val?.comment_id ? String(val.comment_id) : "";
        const commentText = typeof val?.message === "string" ? val.message.trim() : "";

        if (!commenterId || !commentId || !commentText) {
          continue;
        }
        if (pageId && commenterId === pageId) {
          continue;
        }

        if (await isDuplicateEvent(`feed_comment_${commentId}`)) {
          continue;
        }

        const reply = await generateMariamReply(
          commenterId,
          `[تعليق على بث مباشر / منشور]: ${commentText}`,
          "تعليق مباشر على البث المباشر أو المنشور (الرد يظهر تحت التعليق)"
        );
        await sendCommentReply(commentId, reply);
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
