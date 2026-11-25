import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

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

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

async function isDuplicateEvent(key: string): Promise<boolean> {
  if (!redis) return false;
  try {
    const existing = await redis.get(key);
    if (existing) return true;
    await redis.set(key, "1", { ex: 600 });
    return false;
  } catch (err) {
    console.error("[webhook] redis dedupe err:", err);
    return false;
  }
}

async function sendCommentReply(commentId: string, message: string) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("[webhook] missing FB_PAGE_ACCESS_TOKEN");
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
    const text = await res.text();
    console.log("[webhook] Graph API comment reply:", {
      commentId,
      status: res.status,
      ok: res.ok,
      body: text,
    });
  } catch (err) {
    console.error("[webhook] sendCommentReply network err:", err);
  }
}

function buildCalmReply(commentText: string): string {
  const clean = (commentText || "").trim();
  if (!clean) {
    return "أهلاً بك. تفضل باكتب سؤالك بوضوح هنا أو ابعثلنا على الميسنجر باش نعاونوك.";
  }
  return "أهلاً بك. بالنسبة للمعلومة أو التوفر أو الطلب، نثبتولك المعطيات الدقيقة قبل أي تأكيد. إذا تحب تبعث تفاصيل أكثر أو تطلب، تفضل على الميسنجر ونجاوبوك بوضوح.";
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
    });

    if (body?.object !== "page" || !Array.isArray(body?.entry)) {
      return NextResponse.json({ status: "ignored_non_page" }, { status: 200 });
    }

    for (const entry of body.entry) {
      const pageId = entry?.id ? String(entry.id) : "";

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
            const messageText = typeof val?.message === "string" ? val.message : "";

            if (verb !== "add") {
              console.log("[webhook] skip comment verb:", verb);
              continue;
            }

            if (!commentId) {
              console.log("[webhook] missing comment_id");
              continue;
            }

            if (pageId && commenterId === pageId) {
              console.log("[webhook] comment made by page itself, skipping");
              continue;
            }

            const dedupeKey = `feed_comment_${commentId}`;
            if (await isDuplicateEvent(dedupeKey)) {
              console.log("[webhook] duplicate comment skipped:", commentId);
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
