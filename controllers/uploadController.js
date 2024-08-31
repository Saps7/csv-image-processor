import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import path from 'path';
import axios from 'axios';
import Product from '../models/product.js';
import RequestStatus from '../models/requestStatus.js';
import FormData from 'form-data';
import AWS from 'aws-sdk';
import { Worker } from 'worker_threads';

// Configure AWS
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const s3 = new AWS.S3();

// Function to upload file to S3
async function uploadToS3(fileContent, key) {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
        Body: fileContent
    };

    return new Promise((resolve, reject) => {
        s3.upload(params, (err, data) => {
            if (err) reject(err);
            else resolve(data.Location);
        });
    });
}

// Function to download file from S3
async function downloadFromS3(key) {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key
    };

    return new Promise((resolve, reject) => {
        s3.getObject(params, (err, data) => {
            if (err) reject(err);
            else resolve(data.Body);
        });
    });
}

function isValidImageUrl(url) {
    const validExtensions = ['.jpg', '.jpeg', '.png'];
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return validExtensions.includes(extension);
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
        // Upload CSV to S3 directly from the buffer
        const csvKey = `input/${Date.now()}_${req.file.originalname}`;
        await uploadToS3(req.file.buffer, csvKey);

        // Parse CSV content from the buffer
        const fileContent = req.file.buffer.toString('utf8');
        let records = parse(fileContent, { columns: true, skip_empty_lines: true });

        const requestId = Date.now().toString();

        // Create initial status record
        await RequestStatus.create({ requestId, status: 'processing' });

        // Start asynchronous processing
        processRecordsAsync(requestId, records, webhookUrl);

        res.json({ message: 'Processing started', requestId });
    } catch (error) {
        console.error('Error processing CSV:', error);
        res.status(500).json({ error: 'Error processing CSV file' });
    }
};

async function processRecordsAsync(requestId, records, webhookUrl) {
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
                const key = `input/${requestId}_${fileName}`;
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                await uploadToS3(response.data, key);
                return key;
            }));
            return {
                productName: record['Product Name'],
                inputImageUrls: inputUrls,
                downloadedPaths,
                outputImageUrls: []
            };
        }));

        processImagesAsync(requestId, results, webhookUrl);
    } catch (error) {
        console.error('Error processing records:', error);
        await RequestStatus.findOneAndUpdate(
            { requestId },
            { status: 'failed', error: error.message }
        );
        await triggerWebhook(requestId, null, webhookUrl, error.message);
    }
}

function processImagesAsync(requestId, results, webhookUrl) {
    const worker = new Worker(new URL('../workers/imageProcessor.js', import.meta.url));

    worker.postMessage({ results, bucketName: process.env.S3_BUCKET_NAME });

    worker.on('message', async (outputUrls) => {
        try {
            // Update results with output URLs
            results.forEach((result, index) => {
                result.outputImageUrls = outputUrls[index];
            });

            // Save to MongoDB
            for (const result of results) {
                const product = new Product({
                    productName: result.productName,
                    inputImages: result.inputImageUrls.map((url, i) => ({
                        url: url,
                        storagePath: result.downloadedPaths[i]
                    })),
                    outputImages: result.outputImageUrls.map(url => ({
                        url: url,
                        storagePath: url.replace(`https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/`, '')
                    })),
                    processedAt: new Date()
                });
                await product.save();
            }

            // Generate output CSV
            const csvOutput = stringify(results.map(r => ({
                'Product Name': r.productName,
                'Input Image Urls': r.inputImageUrls.join(','),
                'Output Image Urls': r.outputImageUrls.join(',')
            })), { header: true });

            // Upload CSV to S3
            const csvKey = `output/${requestId}_output.csv`;
            await uploadToS3(Buffer.from(csvOutput), csvKey);

            // Update status to completed
            await RequestStatus.findOneAndUpdate(
                { requestId },
                { status: 'completed', completedAt: new Date() }
            );

            // Trigger webhook
            await triggerWebhook(requestId, csvKey, webhookUrl);

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

async function triggerWebhook(requestId, csvKey, webhookUrl, error = null) {
    if (!webhookUrl) {
        console.log('No webhook URL provided');
        return;
    }

    const form = new FormData();
    form.append('requestId', requestId);

    if (csvKey) {
        try {
            const csvContent = await downloadFromS3(csvKey);
            form.append('csv', csvContent, {
                filename: `${requestId}_output.csv`,
                contentType: 'text/csv',
            });
        } catch (downloadError) {
            console.error(`Error downloading CSV from S3: ${downloadError}`);
            form.append('error', 'Error retrieving CSV file');
        }
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
