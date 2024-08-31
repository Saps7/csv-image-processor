import { parentPort, workerData } from 'worker_threads';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function processImage(inputPath) {
  const fileName = path.basename(inputPath);
  const outputPath = path.join(__dirname, '..', 'uploads', 'output', fileName);

  try {
    const image = sharp(inputPath);
    const metadata = await image.metadata();

    let compressedImage;
    switch (metadata.format) {
      case 'jpeg':
      case 'jpg':
        compressedImage = image.jpeg({ quality: 60 });
        break;
      case 'png':
        compressedImage = image.png({ quality: 60 });
        break;
      default:
        throw new Error('Unsupported image format');
    }

    await compressedImage.toFile(outputPath);
    return `/uploads/output/${fileName}`; // This is the path that will be served statically
  } catch (error) {
    console.error(`Error processing image ${fileName}:`, error);
    return null;
  }
}

async function processImages(images) {
  const results = await Promise.all(images.map(processImage));
  const validResults = results.filter(result => result !== null);
  parentPort.postMessage(validResults);
}

processImages(workerData);
