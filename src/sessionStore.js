// src/sessionStore.js
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  data: Object
});
const Session = mongoose.model('Session', sessionSchema);

export async function loadSession() {
  const doc = await Session.findOne({ id: 'default' });
  return doc?.data || null;
}

export async function saveSession(data) {
  await Session.updateOne({ id: 'default' }, { data }, { upsert: true });
}
