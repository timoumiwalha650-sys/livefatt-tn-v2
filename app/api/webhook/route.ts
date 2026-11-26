import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUILD_TAG = "v2026-11-26-clean-reply";

const VERIFY_TOKEN =
  process.env.FB_VERIFY_TOKEN ||
  process.env.WEBHOOK_VERIFY_TOKEN ||
  "livefatt_verify_token_2026";

const PAGE_ACCESS_TOKEN =
  process.env.FB_PAGE_ACCESS_TOKEN ||
  process.env.PAGE_ACCESS_TOKEN ||
  "";

const GRAPH_API_VERSION = process.env.FB_GRAPH_VERSION || "v24.0";

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const RECIPIENT_COOLDOWN_MS = 12 * 1000;
const seenEvents = new Map<string, number>();

function isDuplicateEvent(key: string, ttlMs: number = DEDUPE_TTL_MS): boolean {
  const now = Date.now();
  for (const [k, exp] of seenEvents.entries()) {
    if (exp <= now) {
      seenEvents.delete(k);
    }
  }
  const existingExp = seenEvents.get(key);
  if (existingExp && existingExp > now) {
    return true;
  }
  seenEvents.set(key, now + ttlMs);
  return false;
}

async function sendMessengerReply(recipientId: string, text: string) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("[webhook] missing FB_PAGE_ACCESS_TOKEN for messenger", {
      build: BUILD_TAG,
    });
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(
    PAGE_ACCESS_TOKEN
  )}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    });
    const raw = await res.text();
    console.log("[webhook] messenger Graph API result:", {
      build: BUILD_TAG,
      recipientId,
      status: res.status,
      ok: res.ok,
      raw,
    });
  } catch (err) {
    console.error("[webhook] sendMessengerReply network error:", {
      build: BUILD_TAG,
      err,
    });
  }
}

async function sendCommentReply(commentId: string, message: string) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("[webhook] missing FB_PAGE_ACCESS_TOKEN for comment", {
      build: BUILD_TAG,
    });
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
    commentId
  )}/comments?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const raw = await res.text();
    console.log("[webhook] comment Graph API result:", {
      build: BUILD_TAG,
      commentId,
      status: res.status,
      ok: res.ok,
      raw,
    });
  } catch (err) {
    console.error("[webhook] sendCommentReply network error:", {
      build: BUILD_TAG,
      err,
    });
  }
}

function buildNaturalFallbackReply(
  rawText: string,
  channel: "messenger" | "comment"
): string {
  const clean = (rawText || "").trim();
  const lower = clean.toLowerCase();

  if (!clean) {
    return "أهلاً بك في The Viral Creature. قولي شنوة تحب تعرف أو تطلب اليوم باش نعطيك المعلومة الصحيحة.";
  }

  if (
    lower.includes("salam") ||
    lower.includes("slam") ||
    lower.includes("selam") ||
    lower.includes("hi") ||
    lower.includes("hello") ||
    clean.includes("سلام") ||
    clean.includes("أهلا") ||
    clean.includes("أهلاً") ||
    clean.includes("مرحبا") ||
    clean.includes("صباح") ||
    clean.includes("مساء")
  ) {
    return "أهلاً وسهلاً بك في The Viral Creature. كيفاش نجم نعاونك اليوم؟ تحب تسأل على سلعة جديدة، سوم، ولا طلبية؟";
  }

  if (
    clean.includes("سلعة جديدة") ||
    clean.includes("جديد") ||
    clean.includes("موديل") ||
    clean.includes("شنوة عندكم") ||
    clean.includes("شنو عندكم") ||
    clean.includes("موجود") ||
    clean.includes("صباط") ||
    lower.includes("nike") ||
    clean.includes("نايك")
  ) {
    return "نثبتولك توفر القطعة والموديل والمقاسات الموجودة حالياً قبل أي تأكيد. قولي شنوة المقاس أو اللون اللي يهمك بالضبط باش نجاوبك بدقة.";
  }

  if (
    clean.includes("سوم") ||
    clean.includes("بقداش") ||
    clean.includes("ثمن") ||
    clean.includes("سعر") ||
    clean.includes("prix") ||
    clean.includes("توصيل") ||
    clean.includes("livraison")
  ) {
    return "نثبتولك السوم الدقيق ومعلوم التوصيل حسب الموديل والولاية. قولي اسم أو وصف القطعة والولاية باش نعطيك التفاصيل الصحيحة.";
  }

  if (
    clean.includes("لايف") ||
    clean.includes("live") ||
    clean.includes("كوموند") ||
    clean.includes("طلبية") ||
    clean.includes("نحب نطلب")
  ) {
    if (channel === "comment") {
      return "وصل تعليقك. نثبتولك تفاصيل القطعة والطلبية، وقولي الموديل والمقاس أو اللون اللي تحبو.";
    }
    return "وصلتنا رسالتك بخصوص الطلبية. قولي الموديل والمقاس أو اللون اللي تحبو باش نثبتولك التفاصيل قبل التأكيد.";
  }

  return "وصلنا سؤالك ونثبتولك التفاصيل الصحيحة قبل أي تأكيد. قولي شنوة تحب نوضّحلك فيه أكثر بالضبط؟";
}

async function generateMariamReply(
  rawText: string,
  channel: "messenger" | "comment"
): Promise<string> {
  const clean = (rawText || "").trim();
  const openaiKey = process.env.OPENAI_API_KEY || "";

  if (openaiKey && clean) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.35,
          max_tokens: 180,
          messages: [
            {
              role: "system",
              content:
                "أنت مريم، مساعدة صفحة The Viral Creature في تونس. تحدثي بلهجة تونسية واضحة، هادئة، صادقة ومباشرة دون مبالغة أو وعود غير مؤكدة أو هلوسة. أجيبي مباشرة على السؤال أو التعليق باختصار مفيد وواضح، وإذا احتاج الأمر لتثبيت موديل أو مقاس أو سعر أو توصيل اطلبي التوضيح بدقة.",
            },
            {
              role: "user",
              content: `القناة: ${channel === "messenger" ? "رسالة Messenger" : "تعليق على منشور/لايف"}\nالنص: ${clean}`,
            },
          ],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const aiText = data?.choices?.[0]?.message?.content?.trim();
        if (aiText) {
          return aiText;
        }
      } else {
        console.warn("[webhook] OpenAI non-ok status:", {
          build: BUILD_TAG,
          status: res.status,
        });
      }
    } catch (err) {
      console.warn("[webhook] OpenAI fallback triggered:", {
        build: BUILD_TAG,
        err,
      });
    }
  }

  return buildNaturalFallbackReply(clean, channel);
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  let rawBody = "";
  try {
    rawBody = await req.text();
    const body = JSON.parse(rawBody);

    console.log("[webhook] POST received:", {
      build: BUILD_TAG,
      object: body?.object,
      entries: Array.isArray(body?.entry) ? body.entry.length : 0,
      hasToken: Boolean(PAGE_ACCESS_TOKEN),
    });

    if (body?.object !== "page" || !Array.isArray(body?.entry)) {
      return NextResponse.json(
        { status: "ignored", build: BUILD_TAG },
        { status: 200 }
      );
    }

    for (const entry of body.entry) {
      const pageId = entry?.id ? String(entry.id) : "";

      if (Array.isArray(entry?.messaging)) {
        for (const ev of entry.messaging) {
          const senderId = ev?.sender?.id ? String(ev.sender.id) : "";
          const mid = ev?.message?.mid ? String(ev.message.mid) : "";
          const isEcho = Boolean(ev?.message?.is_echo);
          const msgText =
            typeof ev?.message?.text === "string" ? ev.message.text : "";

          console.log("[webhook] messaging event:", {
            build: BUILD_TAG,
            pageId,
            senderId,
            mid,
            isEcho,
            hasText: Boolean(msgText),
          });

          if (!senderId || !ev?.message || isEcho) {
            continue;
          }

          if (pageId && senderId === pageId) {
            continue;
          }

          const midKey = mid
            ? `msg_${mid}`
            : `msg_${senderId}_${ev?.timestamp || ""}`;
          const recipientThrottleKey = `throttle_m_${senderId}`;

          if (
            isDuplicateEvent(midKey) ||
            isDuplicateEvent(recipientThrottleKey, RECIPIENT_COOLDOWN_MS)
          ) {
            console.log("[webhook] duplicate or throttled messenger skipped:", {
              build: BUILD_TAG,
              midKey,
              recipientThrottleKey,
            });
            continue;
          }

          const reply = await generateMariamReply(msgText, "messenger");
          await sendMessengerReply(senderId, reply);
        }
      }

      if (Array.isArray(entry?.changes)) {
        for (const ch of entry.changes) {
          const field = ch?.field;
          const val = ch?.value || {};

          console.log("[webhook] feed/change event:", {
            build: BUILD_TAG,
            pageId,
            field,
            item: val?.item,
            verb: val?.verb,
            postId: val?.post_id,
            commentId: val?.comment_id,
            fromId: val?.from?.id,
            hasMessage: Boolean(val?.message),
          });

          if (field === "feed" && val?.item === "comment") {
            const verb = val?.verb || "add";
            const commentId = val?.comment_id ? String(val.comment_id) : "";
            const commenterId = val?.from?.id ? String(val.from.id) : "";
            const messageText =
              typeof val?.message === "string" ? val.message : "";

            if (verb !== "add" || !commentId) {
              continue;
            }

            if (pageId && commenterId === pageId) {
              continue;
            }

            const commentKey = `comment_${commentId}`;
            const commenterThrottleKey = `throttle_c_${commenterId}`;

            if (
              isDuplicateEvent(commentKey) ||
              isDuplicateEvent(commenterThrottleKey, RECIPIENT_COOLDOWN_MS)
            ) {
              console.log("[webhook] duplicate or throttled comment skipped:", {
                build: BUILD_TAG,
                commentKey,
              });
              continue;
            }

            const replyText = await generateMariamReply(messageText, "comment");
            await sendCommentReply(commentId, replyText);
          }
        }
      }
    }

    return NextResponse.json(
      { status: "ok", build: BUILD_TAG },
      { status: 200 }
    );
  } catch (err) {
    console.error("[webhook] POST error:", {
      build: BUILD_TAG,
      err,
      len: rawBody.length,
    });
    return NextResponse.json(
      { status: "ok", build: BUILD_TAG },
      { status: 200 }
    );
  }
}
