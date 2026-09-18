import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import scanScheduleHandler from './scan-schedule.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// API health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// AI Schedule Scanner API route
app.post('/api/scan-schedule', scanScheduleHandler);

// Serve static assets from project root
app.use(express.static(__dirname));

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`STUDY OS server listening on http://0.0.0.0:${PORT}`);
});
