import mongoose from 'mongoose';

const requestStatusSchema = new mongoose.Schema({
  requestId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    default: 'processing'
  },
  completedAt: Date,
  error: String
}, { timestamps: true });

const RequestStatus = mongoose.model('RequestStatus', requestStatusSchema);

export default RequestStatus;