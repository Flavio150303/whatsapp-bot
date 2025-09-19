// bot.js
// Copia y pega TODO este archivo (mantiene tu lógica de grupos + muestra QR en la consola)

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "baileys"
import qrcodeTerminal from "qrcode-terminal"
import pino from "pino"

const logger = pino({ level: "info" })

// === CONFIGURACIÓN: usa tus IDs de grupo tal como los tenías ===
const GROUP_1 = "120363403320326307@g.us" // Grupo origen (donde escriben "fraude")
const GROUP_2 = "120363403008545576@g.us" // Grupo destino (a donde se reenvía)
// ==================================================================

async function startBot() {
  try {
    // carga/crea auth en ./auth
    const { state, saveCreds } = await useMultiFileAuthState("./auth")
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      // No confiamos en printQRInTerminal (deprecated): nosotros mostramos el QR cuando llegue el evento.
      printQRInTerminal: false
    })

    // Guardar credenciales cuando cambien
    sock.ev.on("creds.update", saveCreds)

    // Connection updates: qr, open, close
    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          // Mostrar QR en consola (ASCII)
          logger.info("📲 QR actualizado — escanea este QR con WhatsApp → Dispositivos → Vincular dispositivo")
          qrcodeTerminal.generate(qr, { small: true })
          // Además imprimimos el string por si necesitas pegarlo en otro generador:
          console.log("\n--- QR STRING (opcional) ---\n", qr, "\n")
        }

        if (connection === "open") {
          logger.info("✅ Bot conectado a WhatsApp")
        }

        if (connection === "close") {
          logger.warn("⚠️ Conexión cerrada:", lastDisconnect?.error ?? "unknown")
          // Reintentar reconectar automáticamente
          try {
            await startBot()
          } catch (e) {
            logger.error("Error reiniciando bot:", e)
          }
        }
      } catch (e) {
        logger.error("Error en connection.update handler:", e)
      }
    })

    // Mensajes entrantes
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const m = messages[0]
        if (!m || !m.message) return
        if (m.key.fromMe) return // ignorar mensajes que enviamos nosotros

        const chatId = m.key.remoteJid
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          (m.message?.imageMessage?.caption) ||
          ""

        logger.info(`📩 [${chatId}] ${text}`)

        // Detectar palabra "fraude" (insensible a mayúsculas) y reenviar solo si viene del GROUP_1
        if (chatId === GROUP_1 && String(text).toLowerCase().includes("fraude")) {
          logger.info("🚨 FRAUDE detectado, reenviando...")

          try {
            // Intentar reenviar el mensaje original (manteniendo tipo/media) con relayMessage
            await sock.relayMessage(GROUP_2, m.message, { messageId: m.key.id })
            logger.info("✅ Mensaje reenviado con relayMessage")
          } catch (err) {
            // Si falla (por cifrado/keys), hacer fallback a texto
            logger.warn("relayMessage falló, usando fallback (texto):", err?.message || err)
            const fallbackText = `🚨 Mensaje reenviado del Grupo 1:\n"${text}"`
            try {
              await sock.sendMessage(GROUP_2, { text: fallbackText })
              logger.info("✅ Mensaje reenviado con fallback (texto)")
            } catch (e2) {
              logger.error("❌ Error reenviando por fallback:", e2)
            }
          }
        }
      } catch (e) {
        logger.error("Error procesando messages.upsert:", e)
      }
    })
  } catch (e) {
    logger.error("Error en startBot():", e)
  }
}

// Arranca el bot
startBot()
