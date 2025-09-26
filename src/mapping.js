// src/models/Mapping.js
import mongoose from 'mongoose';

const mappingSchema = new mongoose.Schema({
  telegramMsgId: { type: Number, required: true, unique: true, index: true },
  waJid: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Mapping || mongoose.model('Mapping', mappingSchema);
