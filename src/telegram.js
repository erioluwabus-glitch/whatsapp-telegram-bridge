// src/telegram.js
// Minimal Telegram helper using native fetch (no node-telegram-bot-api).
// Provides webhook handler factory + send helpers + webhook setter.

import assert from "assert";

export function createTelegram({ token = process.env.TELEGRAM_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID } = {}) {
  assert(token, "TELEGRAM_TOKEN is required (env TELEGRAM_TOKEN)");

  const apiBase = `https://api.telegram.org/bot${token}`;

  async function sendRaw(method, body) {
    const url = `${apiBase}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const err = new Error(`Telegram ${method} failed: ${JSON.stringify(json || res.statusText)}`);
      err.response = json;
      throw err;
    }
    return json;
  }

  async function sendMessage(toChatId, text, opts = {}) {
    if (!toChatId) throw new Error("chatId required");
    const payload = Object.assign({ chat_id: toChatId, text }, opts);
    return sendRaw("sendMessage", payload);
  }

  // createWebhookHandler(onUpdate) => async function(body)
  // onUpdate receives the parsed Telegram update object.
  function createWebhookHandler(onUpdate) {
    if (typeof onUpdate !== "function") {
      throw new Error("createWebhookHandler expects a function (onUpdate)");
    }

    // return the handler you will call from your POST /telegram/:token route
    return async function handleTelegramWebhook(update) {
      try {
        // Basic shape check
        if (!update || typeof update !== "object") {
          throw new Error("invalid update");
        }

        // We'll call the user's onUpdate and allow it to process replies etc.
        // Keep it resilient: don't throw on user error — propagate so caller logs it.
        await onUpdate(update);
      } catch (err) {
        // Re-throw so the server can return 500 and log details
        throw err;
      }
    };
  }

  // Sets webhook for this bot to given baseUrl (must be HTTPS reachable) — path used: /telegram/<token>
  async function setWebhook(webhookBaseUrl, options = {}) {
    if (!webhookBaseUrl) throw new Error("webhookBaseUrl required to set webhook");
    const base = String(webhookBaseUrl).replace(/\/$/, "");
    const webhookUrl = `${base}/telegram/${token}`;

    // recommended params for Telegram webhooks
    const body = {
      url: webhookUrl,
      // tell Telegram what updates you want; omit to accept all
      allowed_updates: options.allowed_updates || ["message", "edited_message", "channel_post", "edited_channel_post"],
      // optionally set max_connections etc.
      max_connections: options.max_connections || 40,
    };

    try {
      const res = await sendRaw("setWebhook", body);
      console.info("✅ Telegram webhook set successfully", webhookUrl);
      return res;
    } catch (err) {
      // Provide actionable message
      if (err?.response?.description?.includes("Conflict")) {
        console.warn("⚠️ Telegram returned Conflict when setting webhook. This usually means another instance is using getUpdates/polling or webhook already set to a different URL.");
      }
      throw err;
    }
  }

  async function deleteWebhook() {
    try {
      const res = await sendRaw("deleteWebhook", {});
      console.info("✅ Telegram webhook deleted");
      return res;
    } catch (err) {
      console.warn("Failed to delete webhook:", err?.response?.description || err.message || err);
      throw err;
    }
  }

  return {
    token,
    chatId,
    sendRaw,
    sendMessage,
    createWebhookHandler,
    setWebhook,
    deleteWebhook,
    apiBase,
  };
}
