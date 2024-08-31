import mongoose from 'mongoose';

const productSchema = new mongoose.Schema({
  sNo: Number,
  productName: String,
  inputImages: [{
    url: String,
    storagePath: String
  }],
  outputImages: [{
    url: String,
    storagePath: String
  }],
  processedAt: Date
});

const Product = mongoose.model('Product', productSchema);

export default Product;