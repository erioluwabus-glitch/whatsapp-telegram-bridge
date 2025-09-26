// src/whatsapp.js
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import P from "pino";
import { bot } from "./telegram.js";

/**
 * Start WhatsApp socket and bridge messages to Telegram
 */
export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true, // show QR in Render logs
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("📌 Scan this QR to link WhatsApp:");
      console.log(qr);
    }
    if (connection === "open") {
      console.log("✅ WhatsApp connected");
    } else if (connection === "close") {
      console.error("⚠️ WhatsApp connection closed", lastDisconnect?.error);
    }
  });

  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0];
    if (!m.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      null;

    if (text) {
      console.log("📩 WhatsApp → Telegram:", text);
      try {
        await bot?.sendMessage(
          process.env.TELEGRAM_CHAT_ID,
          `📲 From WhatsApp (${from}): ${text}`
        );
      } catch (err) {
        console.error("❌ Failed to send WhatsApp → Telegram", err);
      }
    }
  });

  console.log("✅ WhatsApp bridge active");
  return sock;
}
