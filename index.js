const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI, createUserContent, createPartFromUri } = require('@google/genai');
const { google } = require('googleapis');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN não definido');
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não definido');
if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID não definido');

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const app = express();

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

const SHEET = 'Lancamentos';

function money(v) {
  return Number(v || 0).toFixed(2).replace('.', ',');
}

function clean(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\bleo\b/g, '')
    .replace(/r\$/g, '')
    .replace(/reais?/g, '')
    .trim();
}

async function getRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A:G`
  });

  const rows = res.data.values || [];
  return rows.slice(1).map((r, i) => ({
    row: i + 2,
    id: Number(r[0]),
    tipo: r[2],
    valor: Number(r[3]),
    categoria: r[4],
    descricao: r[5],
    data: r[1]
  }));
}

async function add(tipo, valor, categoria, desc) {
  const rows = await getRows();
  const id = rows.length ? Math.max(...rows.map(r => r.id)) + 1 : 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[id, new Date().toISOString(), tipo, valor, categoria, desc, '']]
    }
  });

  return id;
}

async function saldo() {
  const rows = await getRows();
  return rows.reduce((acc, r) => acc + (r.tipo === 'receita' ? r.valor : -r.valor), 0);
}

async function ultimos() {
  const rows = await getRows();
  return rows.slice(-5).reverse();
}

async function interpretar(texto) {
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `
Extraia JSON:
{ "eh": true/false, "tipo": "gasto|receita", "valor": number, "categoria": "string" }

Texto: ${texto}
`,
    config: { responseMimeType: 'application/json' }
  });

  return JSON.parse(res.text || '{}');
}

// DASHBOARD
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api', async (req, res) => {
  const rows = await getRows();

  const gasto = rows.filter(r => r.tipo === 'gasto').reduce((a,b)=>a+b.valor,0);
  const receita = rows.filter(r => r.tipo === 'receita').reduce((a,b)=>a+b.valor,0);

  res.json({
    saldo: receita - gasto,
    gasto,
    receita,
    ultimos: rows.slice(-10).reverse()
  });
});

app.listen(PORT, () => {
  console.log('📊 Dashboard rodando');
});

// TELEGRAM
bot.on('message', async msg => {
  const chatId = msg.chat.id;

  try {
    if (msg.text) {
      const t = clean(msg.text);

      if (t === '/start') {
        return bot.sendMessage(chatId, 'FinLeo PRO ativo 🚀');
      }

      if (t === 'saldo') {
        const s = await saldo();
        return bot.sendMessage(chatId, `💰 R$ ${money(s)}`);
      }

      if (t === 'ultimos') {
        const u = await ultimos();
        const txt = u.map(x => `#${x.id} ${x.categoria} R$ ${money(x.valor)}`).join('\n');
        return bot.sendMessage(chatId, txt);
      }

      const dados = await interpretar(msg.text);

      if (dados.eh && dados.valor) {
        await add(dados.tipo, dados.valor, dados.categoria || 'geral', msg.text);
        const s = await saldo();
        return bot.sendMessage(chatId, `✔️ R$ ${money(dados.valor)} (${dados.categoria})\nSaldo: R$ ${money(s)}`);
      }

      return bot.sendMessage(chatId, 'Não entendi');
    }

  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, 'Erro');
  }
});

console.log('✅ FinLeo PRO iniciado');
