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
    console.log("[webhook] Graph API messenger reply:", {
      recipientId,
      status: res.status,
      ok: res.ok,
      body: raw,
    });
  } catch (err) {
    console.error("[webhook] sendMessengerReply network err:", err);
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
    console.log("[webhook] Graph API comment reply:", {
      commentId,
      status: res.status,
      ok: res.ok,
      body: raw,
    });
  } catch (err) {
    console.error("[webhook] sendCommentReply network err:", err);
  }
}

function buildCalmReply(inputText: string): string {
  const clean = (inputText || "").trim();
  if (!clean) {
    return "أهلاً بك. تفضل قولي بوضوح شنوة تحب تعرف أو تطلب، ونثبتولك التفاصيل قبل أي تأكيد.";
  }
  return "أهلاً بك. وصلتنا رسالتك، ونثبتولك المعطيات الدقيقة قبل أي تأكيد. إذا تحب تزيد توضح شنوة حاجتك بالضبط (الموديل، اللون، أو الاستفسار) أنا معاك.";
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
      entryCount: Array.isArray(body?.entry) ? body.entry.length : 0,
      hasToken: Boolean(PAGE_ACCESS_TOKEN),
    });

    if (body?.object !== "page" || !Array.isArray(body?.entry)) {
      return NextResponse.json({ status: "ignored_non_page" }, { status: 200 });
    }

    for (const entry of body.entry) {
      const pageId = entry?.id ? String(entry.id) : "";

      if (Array.isArray(entry?.messaging)) {
        for (const ev of entry.messaging) {
          const senderId = ev?.sender?.id ? String(ev.sender.id) : "";
          const recipientId = ev?.recipient?.id ? String(ev.recipient.id) : "";
          const mid = ev?.message?.mid ? String(ev.message.mid) : "";
          const isEcho = Boolean(ev?.message?.is_echo);
          const msgText =
            typeof ev?.message?.text === "string" ? ev.message.text : "";

          console.log("[webhook] messaging event:", {
            pageId,
            senderId,
            recipientId,
            mid,
            isEcho,
            hasText: Boolean(msgText),
          });

          if (!senderId || !ev?.message || isEcho) {
            continue;
          }

          if (pageId && senderId === pageId) {
            console.log("[webhook] skip message sent by page itself");
            continue;
          }

          const dedupeKey = mid ? `msg_${mid}` : `msg_${senderId}_${ev?.timestamp || ""}`;
          if (isDuplicateEvent(dedupeKey)) {
            console.log("[webhook] duplicate messenger skipped:", dedupeKey);
            continue;
          }

          const reply = buildCalmReply(msgText);
          await sendMessengerReply(senderId, reply);
        }
      }

      if (Array.isArray(entry?.changes)) {
        for (const ch of entry.changes) {
          const field = ch?.field;
          const val = ch?.value || {};
          console.log("[webhook] change entry:", {
            pageId,
            field,
            item: val?.item,
            verb: val?.verb,
            commentId: val?.comment_id,
            fromId: val?.from?.id,
            fromName: val?.from?.name,
            message: val?.message,
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

            const dedupeKey = `feed_comment_${commentId}`;
            if (isDuplicateEvent(dedupeKey)) {
              continue;
            }

            const replyText = buildCalmReply(messageText);
            await sendCommentReply(commentId, replyText);
          }
        }
      }
    }

    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    console.error("[webhook] POST error:", err, "rawLen:", rawBody.length);
    return NextResponse.json({ status: "error_handled" }, { status: 200 });
  }
}
