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

// Leer IDs desde variables de entorno (configura esto en Render)
const GROUP_1 = process.env.GROUP_1 || "" // Grupo origen (donde se escribe "fraude")
const GROUP_2 = process.env.GROUP_2 || "" // Grupo destino (a donde se reenvía)

if (!GROUP_1 || !GROUP_2) {
  logger.warn("VARIABLES: Define GROUP_1 y GROUP_2 en las env vars (ej: 1203...@g.us)")
}

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
      printQRInTerminal: false // no imprimimos automático; usamos /qr
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        // generar dataURL del QR para la ruta /qr
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr)
          logger.info("QR actualizado — visita /qr para escanear")
        } catch (e) {
          logger.error("Error generando QR:", e)
        }
      }

      if (connection === "open") {
        logger.info("✅ Bot conectado a WhatsApp")
        latestQrDataUrl = null
      }

      if (connection === "close") {
        logger.warn("Conexión cerrada:", lastDisconnect?.error ?? "unknown")
        // intentar reconectar automática
        startBot().catch((e) => logger.error("Error reiniciando bot:", e))
      }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const m = messages[0]
      if (!m || !m.message) return

      // Evitar procesar nuestros propios mensajes
      if (m.key.fromMe) return

      const chatId = m.key.remoteJid
      // extraer texto (puede venir en conversation o extendedTextMessage)
      const text = m.message.conversation || m.message.extendedTextMessage?.text || ""

      logger.info(`📩 [${chatId}] ${text}`)

      // Si viene del GROUP_1 y contiene "fraude"
      if (chatId === GROUP_1 && text.toLowerCase().includes("fraude")) {
        logger.info("🚨 FRAUDE detectado, reenviando...")

        try {
          // Intentamos reenviar tal cual (relayMessage)
          await sock.relayMessage(GROUP_2, m.message, { messageId: m.key.id })
          logger.info("✅ Mensaje reenviado con relayMessage")
        } catch (err) {
          logger.warn("relayMessage falló, enviando fallback de texto:", err?.message || err)
          // Fallback: enviar solo texto (si el forward falla por keys)
          const fallbackText = `🚨 Mensaje reenviado del Grupo 1:\n"${text}"`
          try {
            await sock.sendMessage(GROUP_2, { text: fallbackText })
            logger.info("✅ Mensaje reenviado por fallback (texto)")
          } catch (e2) {
            logger.error("❌ Error reenviando por fallback:", e2)
          }
        }
      }
    })
  } catch (e) {
    logger.error("Error en startBot():", e)
    // reintentar en X segundos podría hacerse aquí, pero Render reiniciará el proceso si falla
  }
}

startBot()

// Rutas web
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
app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`))
