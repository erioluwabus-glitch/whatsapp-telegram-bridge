// src/models/Session.js
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true }, // e.g. 'baileys-auth-v1'
  files: { type: Map, of: String }, // filename -> file content
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.models.Session || mongoose.model('Session', sessionSchema);
