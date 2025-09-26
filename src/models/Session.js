import mongoose from 'mongoose'

const SessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  data: { type: Object, required: true }
})

export default mongoose.model('Session', SessionSchema)
