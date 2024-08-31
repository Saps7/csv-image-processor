import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { Worker } from 'worker_threads';
import path from 'path';
import axios from 'axios';
import Product from '../models/product.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import RequestStatus from '../models/requestStatus.js';
import FormData from 'form-data';

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

  const webhookUrl = req.body.webhookUrl || process.env.WEBHOOK_URL;

  if (!webhookUrl) {
    return res.status(400).json({ error: 'Webhook URL is required' });
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
    
    // Create initial status record
    await RequestStatus.create({ requestId, status: 'processing' });

    // Start asynchronous processing
    processRecordsAsync(requestId, records, req.get('host'), webhookUrl);

    res.json({ message: 'Processing started', requestId });
  } catch (error) {
    console.error('Error processing CSV:', error);
    res.status(500).json({ error: 'Error processing CSV file' });
  }
};

async function processRecordsAsync(requestId, records, host, webhookUrl) {
  try {
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

    processImagesAsync(requestId, results, host, webhookUrl);
  } catch (error) {
    console.error('Error processing records:', error);
    await RequestStatus.findOneAndUpdate(
      { requestId },
      { status: 'failed', error: error.message }
    );
  }
}

function processImagesAsync(requestId, results, host, webhookUrl) {
  const worker = new Worker('./workers/imageProcessor.js', {
    workerData: results.flatMap(r => r.downloadedPaths)
  });

  worker.on('message', async (outputUrls) => {
    try {
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
        } catch (error) {
          console.error(`Error saving product ${result.productName} to MongoDB:`, error);
        }
      }

      // Generate output CSV
      const csvOutput = stringify(results.map(r => ({
        'Product Name': r.productName,
        'Input Image Urls': r.inputImageUrls.join(','),
        'Output Image Urls': r.outputImageUrls.map(url => `http://${host}${url}`).join(',')
      })), { header: true });
      const outputCsvPath = path.join(__dirname, '..', 'uploads', `${requestId}_output.csv`);
      await fsPromises.writeFile(outputCsvPath, csvOutput);

      // Update status to completed
      await RequestStatus.findOneAndUpdate(
        { requestId },
        { status: 'completed', completedAt: new Date() }
      );

      // Trigger webhook
      await triggerWebhook(requestId, outputCsvPath, webhookUrl);

      console.log(`Processing completed for request ${requestId}`);
    } catch (error) {
      console.error(`Error in worker message handler: ${error}`);
      await RequestStatus.findOneAndUpdate(
        { requestId },
        { status: 'failed', error: error.message }
      );
      await triggerWebhook(requestId, null, webhookUrl, error.message);
    }
  });

  worker.on('error', async (error) => {
    console.error(`Worker error: ${error}`);
    await RequestStatus.findOneAndUpdate(
      { requestId },
      { status: 'failed', error: error.message }
    );
    await triggerWebhook(requestId, null, webhookUrl, error.message);
  });

  worker.on('exit', (code) => {
    if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
  });
}

export const getStatus = async (req, res) => {
  const { requestId } = req.params;
  try {
    const status = await RequestStatus.findOne({ requestId });
    if (!status) {
      return res.status(404).json({ error: 'Request ID not found' });
    }
    res.json(status);
  } catch (error) {
    console.error('Error fetching status:', error);
    res.status(500).json({ error: 'Error fetching status' });
  }
};

async function triggerWebhook(requestId, csvPath, webhookUrl, error = null) {
  if (!webhookUrl) {
    console.log('No webhook URL provided');
    return;
  }

  const form = new FormData();
  form.append('requestId', requestId);
  
  if (csvPath) {
    form.append('csv', fs.createReadStream(csvPath), {
      filename: `${requestId}_output.csv`,
      contentType: 'text/csv',
    });
  }
  
  if (error) {
    form.append('error', error);
  }

  try {
    await axios.post(webhookUrl, form, {
      headers: {
        ...form.getHeaders(),
      },
    });
    console.log(`Webhook triggered for request ${requestId}`);
  } catch (error) {
    console.error(`Error triggering webhook for request ${requestId}:`, error);
  }
}
