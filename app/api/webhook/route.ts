import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
const SHORT_BURST_MS = 8 * 1000;
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
    console.error("[webhook] missing FB_PAGE_ACCESS_TOKEN for messenger");
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
    console.log("[webhook] messenger reply result:", {
      recipientId,
      status: res.status,
      ok: res.ok,
      raw,
    });
  } catch (err) {
    console.error("[webhook] sendMessengerReply network error:", err);
  }
}

async function sendCommentReply(commentId: string, message: string) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("[webhook] missing FB_PAGE_ACCESS_TOKEN for comment");
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
    console.log("[webhook] comment reply result:", {
      commentId,
      status: res.status,
      ok: res.ok,
      raw,
    });
  } catch (err) {
    console.error("[webhook] sendCommentReply network error:", err);
  }
}

function buildSmartFallbackReply(rawText: string, channel: "messenger" | "comment"): string {
  const clean = (rawText || "").trim();
  const lower = clean.toLowerCase();

  if (!clean) {
    return "أهلاً بك. قولي شنوة تحب تعرف أو تطلب بالضبط، ونثبتولك التفاصيل قبل أي تأكيد.";
  }

  if (
    lower.includes("salam") ||
    lower.includes("selam") ||
    clean.includes("سلام") ||
    clean.includes("أهلا") ||
    clean.includes("أهلاً") ||
    clean.includes("مرحبا") ||
    clean.includes("صباح") ||
    clean.includes("مساء")
  ) {
    return "أهلاً وسهلاً بك. مرحبا بك في The Viral Creature، قولي شنوة تحب تستفسر عليه اليوم؟";
  }

  if (
    clean.includes("سلعة جديدة") ||
    clean.includes("جديد") ||
    clean.includes("موديل") ||
    clean.includes("كتالوج") ||
    clean.includes("شنوة عندكم") ||
    clean.includes("شنو عندكم")
  ) {
    return "بالنسبة للسلعة الجديدة والموديلات المتوفرة حالياً، نثبتولك آخر وصولات والقطع الموجودة قبل أي تأكيد. قولي أي نوع أو موديل تقصد بالضبط باش نعطيك المعلومة الصحيحة.";
  }

  if (
    clean.includes("سوم") ||
    clean.includes("بقداش") ||
    clean.includes("ثمن") ||
    clean.includes("prix") ||
    clean.includes("توصيل") ||
    clean.includes("livraison")
  ) {
    return "بخصوص السوم والتوصيل، نثبتولك السعر الدقيق وتفاصيل التوصيل حسب الموديل والولاية. قولي اسم أو وصف القطعة اللي عجبتك باش نثبتولك.";
  }

  if (
    clean.includes("لايف") ||
    clean.includes("live") ||
    clean.includes("كوموند") ||
    clean.includes("نحب نطلب") ||
    clean.includes("طلبية")
  ) {
    if (channel === "comment") {
      return "وصل تعليقك. نثبتولك التفاصيل والطلبية بكل وضوح، وإذا تحب نكملوا التفاصيل على الخاص قولي الموديل والمقاس أو اللون.";
    }
    return "وصلتنا رسالتك. نثبتولك تفاصيل الطلبية والقطع المتوفرة بكل وضوح قبل أي تأكيد—قولي شنوة الموديل أو المقاس اللي تحبو.";
  }

  return `وصلتنا رسالتك بخصوص "${clean}". نثبتولك التفاصيل والمعطيات الدقيقة قبل أي تأكيد—إذا تحب تزيد توضح شنوة حاجتك بالضبط أنا معاك.`;
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
          temperature: 0.4,
          max_tokens: 180,
          messages: [
            {
              role: "system",
              content:
                "أنت مريم، مساعدة صفحة The Viral Creature في تونس. تحدثي بلهجة تونسية واضحة، هادئة، صادقة ومباشرة دون مبالغة أو وعود غير مؤكدة. أجيبي مباشرة على سؤال المستخدم أو تعليقه باختصار مفيد، وإذا احتاج الأمر لتثبيت موديل أو سعر أو توصيل اطلبي التوضيح بدقة.",
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
        console.warn("[webhook] OpenAI non-ok status:", res.status);
      }
    } catch (err) {
      console.warn("[webhook] OpenAI fallback triggered:", err);
    }
  }

  return buildSmartFallbackReply(clean, channel);
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
      object: body?.object,
      entries: Array.isArray(body?.entry) ? body.entry.length : 0,
      hasToken: Boolean(PAGE_ACCESS_TOKEN),
    });

    if (body?.object !== "page" || !Array.isArray(body?.entry)) {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
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

          const midKey = mid ? `msg_${mid}` : `msg_${senderId}_${ev?.timestamp || ""}`;
          const burstKey = `burst_m_${senderId}_${msgText.trim()}`;

          if (isDuplicateEvent(midKey) || isDuplicateEvent(burstKey, SHORT_BURST_MS)) {
            console.log("[webhook] duplicate message skipped:", midKey);
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
            const commenterId = val?.from?.id ? String(val.from?.id) : "";
            const messageText =
              typeof val?.message === "string" ? val.message : "";

            if (verb !== "add" || !commentId) {
              continue;
            }

            if (pageId && commenterId === pageId) {
              continue;
            }

            const commentKey = `comment_${commentId}`;
            const burstKey = `burst_c_${commenterId}_${messageText.trim()}`;

            if (
              isDuplicateEvent(commentKey) ||
              isDuplicateEvent(burstKey, SHORT_BURST_MS)
            ) {
              console.log("[webhook] duplicate comment skipped:", commentKey);
              continue;
            }

            const replyText = await generateMariamReply(messageText, "comment");
            await sendCommentReply(commentId, replyText);
          }
        }
      }
    }

    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    console.error("[webhook] POST error:", err, "len:", rawBody.length);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }
}
