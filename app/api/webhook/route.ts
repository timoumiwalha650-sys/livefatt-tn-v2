import crypto from "crypto";
import { NextRequest, NextResponse, after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUILD_TAG = "v2026-11-26-stable-after-redis";

const VERIFY_TOKEN =
  process.env.FB_VERIFY_TOKEN ||
  process.env.WEBHOOK_VERIFY_TOKEN ||
  "livefatt_verify_token_2026";

const PAGE_ACCESS_TOKEN =
  process.env.FB_PAGE_ACCESS_TOKEN ||
  process.env.PAGE_ACCESS_TOKEN ||
  "";

const APP_SECRET = process.env.FB_APP_SECRET || "";

const GRAPH_API_VERSION = process.env.FB_GRAPH_VERSION || "v24.0";

const UPSTASH_REST_URL = (
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  ""
).replace(/\/+$/, "");

const UPSTASH_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  "";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const CONFIGURED_GEMINI_MODEL = (process.env.GEMINI_MODEL || "").trim();

const DEDUPE_TTL_SEC = 10 * 60;
const localSeen = new Map<string, number>();

const MARIAM_SYSTEM_INSTRUCTION = `إنتِ "مريم"، تخدمي في خدمة الحرفاء متاع صفحة "The Viral Creature" في تونس.
تحكي كيما بنت تونسية عادية تخدم في صفحة بيع: قريبة، باهية، ومحترمة، وصادقة بلا مبالغة ولا اختلاق معلومات.

الأسلوب:
- دارجة تونسية صافية كيما يحكيو التوانسة في الماسنجر، موش فصحى.
- جاوبي قصير: جملة لثلاثة. بلا قوائم، وإيموجي واحد كان لزم.
- ما تعاوديش الترحيب في كل رسالة.
- كان الحريف يكتب بحروف لاتينية (3asslema, chnowa, prix) جاوبيه بنفس الطريقة. بالفرنسي أو الإنجليزي: ردّي بلغته باختصار.

كلمات تستعمليها: توّا، برشا، باهي، وين، كيفاش، علاش، قداش، وقتاش، شنوّة، شكون،
فما / ما فماش، نحب، تنجم، عسلامة، أهلا بيك، يعيشك، يعطيك الصحة.
الفعل للمتكلم بالنون: نعاونك، نثبتلك، نشوفلك، نرجعلك، نبعثلك.

بدّلي كلمات اللهجات الأخرى هكا:
دلوقتي / هلق / دابا → توّا
كتير / ياسر / بزاف / وايد → برشا
عايز / بدي / بغيت → نحب
ليش / ليه / شو / ايش / واش → علاش أو شنوّة حسب المعنى
كاين / موجود → فما
عشان / ديال → علاش / متاع

أمثلة:
الحريف: عسلامة، قداش سوم الصباط هذا؟
مريم: أهلا بيك! نثبتلك في السوم ونرجعلك توّا. أي موديل تقصد بالضبط؟

الحريف: ينجم يوصلني لصفاقس؟
مريم: نثبتلك في التوصيل لصفاقس ونعلمك توّا.

الحريف: chnowa el prix?
مريم: Aslema! Nthabbetlek fil prix w nraj3elek tawa. Chnowa el modèle li t7eb 3lih?

الحريف: نتوما وين؟
مريم: نخدمو في تونس. شنوّة تحب تعرف بالضبط؟`;

function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!APP_SECRET) {
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const providedHex = signatureHeader.slice("sha256=".length).trim();
  const expectedHex = crypto
    .createHmac("sha256", APP_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");

  const a = Buffer.from(providedHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function checkAndSetLocal(key: string, ttlSec: number): boolean {
  const now = Date.now();
  for (const [k, exp] of localSeen.entries()) {
    if (exp <= now) {
      localSeen.delete(k);
    }
  }
  const existingExp = localSeen.get(key);
  if (existingExp && existingExp > now) {
    return false;
  }
  localSeen.set(key, now + ttlSec * 1000);
  return true;
}

async function acquireIdempotencyLock(
  key: string,
  ttlSec: number = DEDUPE_TTL_SEC
): Promise<boolean> {
  if (!checkAndSetLocal(key, ttlSec)) {
    return false;
  }

  if (!UPSTASH_REST_URL || !UPSTASH_REST_TOKEN) {
    return true;
  }

  try {
    const encodedKey = encodeURIComponent(key);
    const url = `${UPSTASH_REST_URL}/set/${encodedKey}/1?NX=true&EX=${ttlSec}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_REST_TOKEN}`,
      },
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.error("[webhook] Upstash SET HTTP failure:", {
        build: BUILD_TAG,
        key,
        status: res.status,
        bodyText,
      });
      return true;
    }

    let parsed: { result?: unknown; error?: unknown } | null = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      console.warn("[webhook] Upstash SET non-JSON response:", {
        build: BUILD_TAG,
        key,
        bodyText,
      });
      return true;
    }

    if (parsed?.error) {
      console.error("[webhook] Upstash SET command error:", {
        build: BUILD_TAG,
        key,
        error: parsed.error,
      });
      return true;
    }

    // "OK" means lock acquired; null means key already exists (duplicate event)
    return parsed?.result === "OK";
  } catch (err) {
    console.error("[webhook] Upstash SET network error:", {
      build: BUILD_TAG,
      key,
      err,
    });
    return true;
  }
}

function buildFallbackReply(
  rawText: string,
  channel: "messenger" | "comment"
): string {
  const clean = (rawText || "").trim();
  const lower = clean.toLowerCase();

  if (
    lower.includes("3asslema") ||
    lower.includes("aslema") ||
    lower.includes("chnowa") ||
    lower.includes("chnoua") ||
    lower.includes("prix")
  ) {
    return "Aslema! Nthabbetlek w nraj3elek tawa. Chnowa el modèle li t7eb 3lih bedhabt?";
  }

  if (channel === "comment") {
    return "أهلا بيك! نثبتلك في تفاصيل القطعة ونرجعلك توّا، قولي شنوّة الموديل ولا المقاس اللي يهمك.";
  }

  return "أهلا بيك! نثبتلك في المعطيات الصحيحة ونرجعلك توّا، قولي شنوّة تحب تعرف بالضبط.";
}

async function generateMariamReply(
  rawText: string,
  channel: "messenger" | "comment"
): Promise<string> {
  const clean = (rawText || "").trim();
  if (!clean) {
    return buildFallbackReply("", channel);
  }

  if (!GEMINI_API_KEY) {
    return buildFallbackReply(clean, channel);
  }

  const candidateModels = Array.from(
    new Set(
      [
        CONFIGURED_GEMINI_MODEL || "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
      ].filter(Boolean)
    )
  );

  for (const model of candidateModels) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: MARIAM_SYSTEM_INSTRUCTION }],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `القناة: ${
                    channel === "messenger" ? "رسالة Messenger" : "تعليق على منشور أو لايف"
                  }\nرسالة الحريف: ${clean}`,
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 1024,
          },
        }),
      });

      const raw = await res.text();
      if (!res.ok) {
        console.warn("[webhook] Gemini HTTP error:", {
          build: BUILD_TAG,
          model,
          status: res.status,
          raw,
        });
        continue;
      }

      const data = JSON.parse(raw);
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason || "UNKNOWN";
      const parts = candidate?.content?.parts || [];
      const replyText = parts
        .map((p: { text?: string }) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim();

      console.log("[webhook] Gemini response meta:", {
        build: BUILD_TAG,
        model,
        finishReason,
        hasText: Boolean(replyText),
      });

      if (replyText) {
        return replyText;
      }
    } catch (err) {
      console.warn("[webhook] Gemini call failed:", {
        build: BUILD_TAG,
        model,
        err,
      });
    }
  }

  return buildFallbackReply(clean, channel);
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

async function processWebhookPayload(rawBody: string) {
  try {
    const body = JSON.parse(rawBody);

    console.log("[webhook] POST payload parsed:", {
      build: BUILD_TAG,
      object: body?.object,
      entries: Array.isArray(body?.entry) ? body.entry.length : 0,
      hasPageToken: Boolean(PAGE_ACCESS_TOKEN),
      hasUpstash: Boolean(UPSTASH_REST_URL && UPSTASH_REST_TOKEN),
      hasGemini: Boolean(GEMINI_API_KEY),
    });

    if (body?.object !== "page" || !Array.isArray(body?.entry)) {
      return;
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

          const lockKey = mid
            ? `livefatt:msg:${mid}`
            : `livefatt:msg:${senderId}:${ev?.timestamp || ""}`;

          const acquired = await acquireIdempotencyLock(lockKey, DEDUPE_TTL_SEC);
          if (!acquired) {
            console.log("[webhook] duplicate message skipped:", {
              build: BUILD_TAG,
              lockKey,
              mid,
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

            const commentLockKey = `livefatt:comment:${commentId}`;
            const acquiredComment = await acquireIdempotencyLock(
              commentLockKey,
              DEDUPE_TTL_SEC
            );
            if (!acquiredComment) {
              console.log("[webhook] duplicate comment skipped:", {
                build: BUILD_TAG,
                commentLockKey,
              });
              continue;
            }

            const replyText = await generateMariamReply(messageText, "comment");
            await sendCommentReply(commentId, replyText);
          }
        }
      }
    }
  } catch (err) {
    console.error("[webhook] processWebhookPayload error:", {
      build: BUILD_TAG,
      err,
      len: rawBody.length,
    });
  }
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
  const rawBody = await req.text();
  const sigHeader = req.headers.get("x-hub-signature-256");

  if (!verifySignature(rawBody, sigHeader)) {
    console.warn("[webhook] invalid x-hub-signature-256", {
      build: BUILD_TAG,
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  after(async () => {
    await processWebhookPayload(rawBody);
  });

  return NextResponse.json({ status: "ok", build: BUILD_TAG }, { status: 200 });
}
