// src/models/Session.js
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  files: { type: Map, of: String }, // saved auth files (filename -> content)
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.models.Session || mongoose.model('Session', sessionSchema);
