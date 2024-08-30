import mongoose from 'mongoose';

const productSchema = new mongoose.Schema({
  productName: String,
  inputImages: [{
    url: String,
    storagePath: String  // Path in your file storage system
  }],
  outputImages: [{
    url: String,
    storagePath: String  // Path in your file storage system
  }],
  processedAt: Date
});

const Product = mongoose.model('Product', productSchema);

export default Product;