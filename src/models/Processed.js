import mongoose from 'mongoose';

const ProcessedSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true }, // e.g., WA message id or TG message id with prefix
  createdAt: { type: Date, default: Date.now, expires: '30d' } // auto-clean
});
export default mongoose.model('Processed', ProcessedSchema);
