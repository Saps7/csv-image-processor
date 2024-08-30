import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { Worker } from 'worker_threads';
import path from 'path';
import axios from 'axios';
import Product from '../models/productModel.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isValidImageUrl(url) {
  const validExtensions = ['.jpg', '.jpeg', '.png'];
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return validExtensions.includes(extension);
}

async function downloadImage(url, filepath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });
  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

export const processCSV = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const fileContent = await fsPromises.readFile(req.file.path, 'utf8');
    let records;
    try {
      records = parse(fileContent, { columns: true, skip_empty_lines: true });
    } catch (parseError) {
      return res.status(400).json({ error: 'CSV Format error' });
    }

    const requestId = Date.now().toString();
    const results = await Promise.all(records.map(async record => {
      if (!record['Product Name'] || !record['Input Image Urls']) {
        throw new Error('CSV Format error');
      }
      const inputUrls = record['Input Image Urls'].split(',').map(url => url.trim());
      if (inputUrls.some(url => !isValidImageUrl(url))) {
        throw new Error('CSV Format error');
      }
      const downloadedPaths = await Promise.all(inputUrls.map(async url => {
        const fileName = path.basename(new URL(url).pathname);
        const filePath = path.join(__dirname, '..', 'uploads', 'input', fileName);
        await downloadImage(url, filePath);
        return filePath;
      }));
      return {
        productName: record['Product Name'],
        inputImageUrls: inputUrls,
        downloadedPaths,
        outputImageUrls: []
      };
    }));

    const host = req.get('host');
    processImagesAsync(requestId, results, host);

    res.json({ message: 'Processing started', requestId });
  } catch (error) {
    console.error('Error processing CSV:', error);
    if (error.message === 'CSV Format error') {
      res.status(400).json({ error: 'CSV Format error' });
    } else {
      res.status(500).json({ error: 'Error processing CSV file' });
    }
  }
};

function processImagesAsync(requestId, results, host) {
  const worker = new Worker('./workers/imageProcessor.js', {
    workerData: results.flatMap(r => r.downloadedPaths)
  });

  worker.on('message', async (outputUrls) => {
    let urlIndex = 0;
    for (const result of results) {
      const recordOutputUrls = outputUrls.slice(urlIndex, urlIndex + result.inputImageUrls.length);
      result.outputImageUrls = recordOutputUrls.filter(url => url !== null);
      urlIndex += result.inputImageUrls.length;

      // Save to MongoDB
      try {
        const product = new Product({
          productName: result.productName,
          inputImages: result.inputImageUrls.map((url, i) => ({
            url: url,
            storagePath: result.downloadedPaths[i]
          })),
          outputImages: result.outputImageUrls.map(url => ({
            url: `http://${host}${url}`,
            storagePath: path.join(__dirname, '..', url)
          })),
          processedAt: new Date()
        });
        await product.save();
        console.log(`Saved product ${result.productName} to MongoDB`);
      } catch (error) {
        console.error(`Error saving product ${result.productName} to MongoDB:`, error);
      }
    }

    // Generate and save output CSV
    const csvOutput = stringify(results.map(r => ({
      'Product Name': r.productName,
      'Input Image Urls': r.inputImageUrls.join(','),
      'Output Image Urls': r.outputImageUrls.map(url => `http://${host}${url}`).join(',')
    })), { header: true });
    await fsPromises.writeFile(path.join(__dirname, '..', 'uploads', `${requestId}_output.csv`), csvOutput);
    console.log(`Processing completed for request ${requestId}`);
  });

  worker.on('error', console.error);
  worker.on('exit', (code) => {
    if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
  });
}
