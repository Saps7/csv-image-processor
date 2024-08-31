import express from 'express';
import multer from 'multer';
import { processCSV, getStatus } from '../controllers/uploadController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('csv'), processCSV);
router.get('/status/:requestId', getStatus);

export default router;
