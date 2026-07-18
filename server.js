const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const { v4: uuid } = require('uuid');
const https = require('https');
const http = require('http');
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new Database('/tmp/data/tempmail.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS inboxes (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    expiresAt INTEGER,
    createdAt INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    inboxId TEXT,
    messageId TEXT,
    fromAddr TEXT,
    toAddr TEXT,
    subject TEXT,
    body TEXT,
    textBody TEXT,
    htmlBody TEXT,
    date TEXT,
    receivedAt INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(inboxId) REFERENCES inboxes(id) ON DELETE CASCADE
  )
`);

const DOMAIN = 'ikechukwuotis.qzz.io';
const CUSTOM_DOMAIN = `@${DOMAIN}`;

function oneSecMailApi(login, domain = '1secmail.com') {
  return {
    api: `https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`,
    read: (id) => `https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${id}`,
    gen: () => `https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1`
  };
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

function randStr(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

app.post('/api/create-inbox', async (req, res) => {
  try {
    const { name } = req.body || {};
    const random = randStr(12);
    const login = `${random}`;
    const email = `${login}@${DOMAIN}`;
    const inboxId = uuid();
    const now = Date.now();
    const expiresAt = now + 3600000;

    db.prepare('INSERT INTO inboxes (id, email, name, expiresAt) VALUES (?,?,?,?)').run(inboxId, email, name || null, expiresAt);

    res.json({ success: true, email, inboxId, expiresAt: new Date(expiresAt).toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/inboxes', (req, res) => {
  try {
    const now = Date.now();
    db.prepare('DELETE FROM inboxes WHERE expiresAt < ?').run(now);
    const rows = db.prepare('SELECT id, email, name, expiresAt, createdAt FROM inboxes ORDER BY createdAt DESC').all();
    res.json({ success: true, inboxes: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function generateBackup(customEmail) {
  // Generate a real 1secmail address for proxy capability
  const data = httpJson('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
  return data;
}

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body, from, htmlBody } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ success: false, error: 'to, subject, body required' });
    }

    const inbox = db.prepare('SELECT * FROM inboxes WHERE email = ?').get(to);
    if (!inbox) {
      return res.status(404).json({ success: false, error: 'Inbox not found or expired' });
    }

    const msgId = uuid();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO messages (id, inboxId, messageId, fromAddr, toAddr, subject, body, textBody, htmlBody, date) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(msgId, inbox.id, msgId, from || 'unknown', to, subject, body, body, htmlBody || '', now);

    res.json({ success: true, messageId: msgId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/messages/:inboxId', (req, res) => {
  try {
    const { inboxId } = req.params;
    const inbox = db.prepare('SELECT * FROM inboxes WHERE id = ?').get(inboxId);
    if (!inbox) {
      return res.status(404).json({ success: false, error: 'Inbox not found' });
    }
    const rows = db.prepare('SELECT id, fromAddr, toAddr, subject, body, textBody, htmlBody, date, receivedAt FROM messages WHERE inboxId = ? ORDER BY receivedAt DESC').all(inboxId);
    res.json({ success: true, email: inbox.email, messages: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/message/:messageId', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.messageId);
    if (!row) return res.status(404).json({ success: false, error: 'Message not found' });
    res.json({ success: true, message: row });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/inbox/:inboxId', (req, res) => {
  try {
    db.prepare('DELETE FROM messages WHERE inboxId = ?').run(req.params.inboxId);
    db.prepare('DELETE FROM inboxes WHERE id = ?').run(req.params.inboxId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/domain', (req, res) => {
  res.json({ success: true, domain: '@' + DOMAIN });
});


app.get('/api/public-messages', (req, res) => {
  try {
    // For self-test / public listing of recent messages across all active inboxes
    const now = Date.now();
    const emails = db.prepare(`
      SELECT m.id, m.fromAddr, m.toAddr, m.subject, m.body, m.date, i.email as inboxEmail
      FROM messages m
      JOIN inboxes i ON m.inboxId = i.id
      WHERE i.expiresAt > ?
      ORDER BY m.receivedAt DESC
      LIMIT 50
    `).all(now);
    res.json({ success: true, messages: emails });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TempMail service running on port ${PORT}`);
  console.log(`Domain: ${DOMAIN}`);
});
