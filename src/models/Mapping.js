import mongoose from 'mongoose'

const MappingSchema = new mongoose.Schema({
  telegramMsgId: { type: Number, required: true, unique: true },
  waJid: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: '14d' } 
  // ⏳ auto-delete mappings after 7 days (adjust if needed)
})

export default mongoose.model('Mapping', MappingSchema)
