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
const seenEvents = new Map<string, number>();

function isDuplicateEvent(key: string): boolean {
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
  seenEvents.set(key, now + DEDUPE_TTL_MS);
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

function buildMariamReply(rawText: string): string {
  const clean = (rawText || "").trim();
  if (!clean) {
    return "أهلاً بك. تفضل قولي شنوة تحب تعرف أو تطلب بالضبط، ونثبتولك التفاصيل قبل أي تأكيد.";
  }
  return "أهلاً بك. وصلتنا رسالتك أو تعليقك، ونثبتولك المعطيات الدقيقة قبل أي تأكيد. إذا تحب تزيد توضح شنوة حاجتك (الموديل، المقاس أو اللون، أو الاستفسار) أنا معاك.";
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

      // 1. معالجة رسائل Messenger
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

          const key = mid ? `msg_${mid}` : `msg_${senderId}_${ev?.timestamp || ""}`;
          if (isDuplicateEvent(key)) {
            console.log("[webhook] duplicate message skipped:", key);
            continue;
          }

          await sendMessengerReply(senderId, buildMariamReply(msgText));
        }
      }

      // 2. معالجة تعليقات feed (على المنشورات العادية والبث المباشر / اللايف)
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
              console.log("[webhook] skip own page comment");
              continue;
            }

            const key = `comment_${commentId}`;
            if (isDuplicateEvent(key)) {
              console.log("[webhook] duplicate comment skipped:", key);
              continue;
            }

            await sendCommentReply(commentId, buildMariamReply(messageText));
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
