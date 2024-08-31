import { parentPort } from 'worker_threads';
import sharp from 'sharp';
import AWS from 'aws-sdk';

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const s3 = new AWS.S3();

async function processImage(inputKey, bucketName) {
  const outputKey = inputKey.replace('input/', 'output/');

  try {
    const inputImage = await s3.getObject({ Bucket: bucketName, Key: inputKey }).promise();
    const image = sharp(inputImage.Body);
    const metadata = await image.metadata();

    let compressedImage;
    switch (metadata.format) {
      case 'jpeg':
      case 'jpg':
        compressedImage = await image.jpeg({ quality: 60 }).toBuffer();
        break;
      case 'png':
        compressedImage = await image.png({ quality: 60 }).toBuffer();
        break;
      default:
        throw new Error('Unsupported image format');
    }

    await s3.putObject({
      Bucket: bucketName,
      Key: outputKey,
      Body: compressedImage,
      ContentType: `image/${metadata.format}`
    }).promise();

    return `https://${bucketName}.s3.amazonaws.com/${outputKey}`;
  } catch (error) {
    console.error(`Error processing image ${inputKey}:`, error);
    return null;
  }
}

parentPort.on('message', async ({ results, bucketName }) => {
  try {
    const processedResults = await Promise.all(results.map(async (result) => {
      const outputUrls = await Promise.all(result.downloadedPaths.map(path => processImage(path, bucketName)));
      return outputUrls.filter(url => url !== null);
    }));
    parentPort.postMessage(processedResults);
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
