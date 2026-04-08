const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3456;
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_DATA = {
  runners: ['Hanner', 'Billie'],
  events: ['1600m', '800m', '400m', '300m Hurdles', '100m Hurdles', '4x800m Relay', '4x400m Relay', '4x200m Relay'],
  races: []
};

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading data.json:', e.message);
  }
  return { ...DEFAULT_DATA };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Initialize data file if missing
if (!fs.existsSync(DATA_FILE)) {
  writeData(DEFAULT_DATA);
}

app.use(express.json());

// CORS: allow GitHub Pages to call the API
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://wakefieldhare-collab.github.io');
  res.header('Access-Control-Allow-Methods', 'GET, PUT');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.put('/api/data', (req, res) => {
  writeData(req.body);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Track Timer running on http://0.0.0.0:${PORT}`);
});
