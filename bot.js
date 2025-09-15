// bot.js
import express from "express"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys"
import QRCode from "qrcode"
import pino from "pino"
import fs from "fs"

const logger = pino({ level: "info" })
const app = express()
let latestQrDataUrl = null

// ✅ Tus grupos originales
const GROUP_1 = "120363403320326307@g.us" // Grupo origen (donde escriben "fraude")
const GROUP_2 = "120363403008545576@g.us" // Grupo destino (a donde se reenvía)

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth")
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false // mostramos el QR en /qr, no en consola
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr)
          logger.info("📲 QR actualizado — visita /qr para escanearlo")
        } catch (e) {
          logger.error("Error generando QR:", e)
        }
      }

      if (connection === "open") {
        logger.info("✅ Bot conectado a WhatsApp")
        latestQrDataUrl = null
      }

      if (connection === "close") {
        logger.warn("⚠️ Conexión cerrada:", lastDisconnect?.error ?? "unknown")
        startBot().catch((e) => logger.error("Error reiniciando bot:", e))
      }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const m = messages[0]
      if (!m || !m.message) return

      if (m.key.fromMe) return // ignorar mis propios mensajes

      const chatId = m.key.remoteJid
      const text =
        m.message.conversation || m.message.extendedTextMessage?.text || ""

      logger.info(`📩 [${chatId}] ${text}`)

      // 🚨 Detectar "fraude" en el grupo 1 y reenviar al grupo 2
      if (chatId === GROUP_1 && text.toLowerCase().includes("fraude")) {
        logger.info("🚨 FRAUDE detectado, reenviando...")

        try {
          await sock.relayMessage(GROUP_2, m.message, { messageId: m.key.id })
          logger.info("✅ Mensaje reenviado con relayMessage")
        } catch (err) {
          logger.warn("relayMessage falló, usando fallback:", err?.message)
          const fallbackText = `🚨 Mensaje reenviado del Grupo 1:\n"${text}"`
          await sock.sendMessage(GROUP_2, { text: fallbackText })
          logger.info("✅ Mensaje reenviado con fallback (texto)")
        }
      }
    })
  } catch (e) {
    logger.error("Error en startBot():", e)
  }
}

startBot()

// Rutas web (para Render)
app.get("/qr", (req, res) => {
  if (!latestQrDataUrl) {
    return res.send(`<h3>No hay QR disponible (ya emparejado o esperando).</h3>
      <p>Si necesitas emparejar, reinicia el servicio o revisa logs.</p>`)
  }
  res.send(`<html><body>
    <h3>Escanea este QR con WhatsApp → Dispositivos → Vincular dispositivo</h3>
    <img src="${latestQrDataUrl}" alt="QR"/>
    </body></html>`)
})

app.get("/health", (req, res) => res.send("ok"))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => logger.info(`🌐 Server escuchando en puerto ${PORT}`))
