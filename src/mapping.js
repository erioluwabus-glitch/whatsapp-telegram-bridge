// Simple runtime mapping (will reset if app restarts)
// Later we could persist in MongoDB if needed
const messageMap = new Map()

export function saveMapping(telegramMsgId, waJid) {
  messageMap.set(telegramMsgId, waJid)
}

export function getMapping(telegramMsgId) {
  return messageMap.get(telegramMsgId)
}
