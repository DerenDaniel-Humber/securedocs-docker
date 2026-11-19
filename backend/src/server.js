import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || '/app/uploads';
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
const allowedTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const documentSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, required: true, trim: true, maxlength: 60 },
  policyNumber: { type: String, trim: true, maxlength: 60, default: '' },
  customerName: { type: String, trim: true, maxlength: 120, default: '' },
  storedName: { type: String, required: true, unique: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const Document = mongoose.model('Document', documentSchema);

const safeEqual = (actual, expected) => {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Basic' || !token) {
    res.set('WWW-Authenticate', 'Basic realm="SecureDocs"');
    return res.status(401).json({ error: 'Sign-in required' });
  }
  let decoded = '';
  try { decoded = Buffer.from(token, 'base64').toString('utf8'); } catch {}
  const splitAt = decoded.indexOf(':');
  const username = splitAt < 0 ? '' : decoded.slice(0, splitAt);
  const password = splitAt < 0 ? '' : decoded.slice(splitAt + 1);
  if (!safeEqual(username, process.env.SECUREDOCS_USER) || !safeEqual(password, process.env.SECUREDOCS_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="SecureDocs"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  next();
});

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    try { await fs.mkdir(uploadDir, { recursive: true }); callback(null, uploadDir); }
    catch (error) { callback(error); }
  },
  filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, allowedTypes.has(file.mimetype))
});

app.get('/api/health', (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({ status: dbReady ? 'ok' : 'waiting', database: dbReady ? 'connected' : 'disconnected' });
});

app.get('/api/documents', async (_req, res, next) => {
  try {
    const documents = await Document.find().sort({ createdAt: -1 }).lean();
    res.json(documents.map(({ storedName, ...doc }) => doc));
  } catch (error) { next(error); }
});

app.post('/api/documents', (req, res, next) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) return next(uploadError);
    if (!req.file) return res.status(400).json({ error: 'Attach a PDF, PNG, JPG, or DOCX file.' });
    const title = String(req.body.title || '').trim();
    const category = String(req.body.category || '').trim();
    if (!title || !category) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Title and category are required.' });
    }
    try {
      const doc = await Document.create({
        title,
        category,
        policyNumber: String(req.body.policyNumber || '').trim(),
        customerName: String(req.body.customerName || '').trim(),
        storedName: req.file.filename,
        originalName: path.basename(req.file.originalname).slice(0, 255),
        mimeType: req.file.mimetype,
        size: req.file.size
      });
      const { storedName, ...response } = doc.toObject();
      res.status(201).json(response);
    } catch (error) {
      await fs.unlink(req.file.path).catch(() => {});
      next(error);
    }
  });
});

app.get('/api/documents/:id/file', async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    const filePath = path.join(uploadDir, path.basename(doc.storedName));
    res.download(filePath, doc.originalName, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});

app.delete('/api/documents/:id', async (req, res, next) => {
  try {
    const doc = await Document.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    await fs.unlink(path.join(uploadDir, path.basename(doc.storedName))).catch(() => {});
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${process.env.MAX_UPLOAD_MB || 10} MB.` : error.message;
    return res.status(400).json({ error: message });
  }
  if (error?.name === 'ValidationError' || error?.name === 'CastError') return res.status(400).json({ error: 'Invalid document details.' });
  if (error?.message === 'Unsupported file type') return res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

await fs.mkdir(uploadDir, { recursive: true });
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/securedocs', { serverSelectionTimeoutMS: 10000 });
const server = app.listen(port, '0.0.0.0', () => console.log(`SecureDocs API listening on ${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  });
}
