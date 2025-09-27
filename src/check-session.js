// check-session.js
import mongoose from 'mongoose';
const MONGO = process.env.MONGO_URI;
if (!MONGO) throw new Error('MONGO_URI env var required');
await mongoose.connect(MONGO);
const doc = await mongoose.connection.db.collection('sessions').findOne({ id: 'baileys-auth-v1' });
console.log('Session doc:', doc ? Object.keys(doc.files || {}) : 'NO SESSION');
await mongoose.disconnect();
process.exit(0);
