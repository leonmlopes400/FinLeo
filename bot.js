const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const OpenAI = require('openai');
const { google } = require('googleapis');

// ===== CONFIG =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ===== WHATSAPP =====
const client = new Client({
  puppeteer: {
    args: ['--no-sandbox']
  }
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Bot conectado!');
});

// ===== GOOGLE SHEETS =====
async function salvarGasto(valor, categoria, descricao) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date().toLocaleString(),
        'gasto',
        valor,
        categoria,
        descricao
      ]]
    }
  });
}

async function calcularSaldo() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A:E'
  });

  const rows = res.data.values || [];
  let saldo = 0;

  rows.slice(1).forEach(linha => {
    const tipo = linha[1];
    const valor = parseFloat(linha[2]);

    if (tipo === 'gasto') saldo -= valor;
    if (tipo === 'receita') saldo += valor;
  });

  return saldo;
}

// ===== PROCESSAMENTO =====
async function processarTexto(texto, msg) {
  texto = texto.toLowerCase();

  if (texto.includes('gastei')) {
    const valor = texto.match(/\d+/)?.[0];

    if (!valor) {
      msg.reply('❌ Não entendi o valor');
      return;
    }

    let categoria = texto.split('gastei')[1];
    categoria = categoria.replace(valor, '').trim();

    await salvarGasto(valor, categoria, texto);
    const saldo = await calcularSaldo();

    msg.reply(`✅ Registrado!
R$${valor} em ${categoria}
💰 Saldo: R$${saldo}`);
  }

  if (texto.includes('saldo')) {
    const saldo = await calcularSaldo();
    msg.reply(`💰 Saldo atual: R$${saldo}`);
  }
}

// ===== MENSAGENS =====
client.on('message', async msg => {

  // TEXTO
  if (!msg.hasMedia) {
    processarTexto(msg.body, msg);
  }

  // ÁUDIO
  if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
    const media = await msg.downloadMedia();
    fs.writeFileSync('audio.ogg', media.data, 'base64');

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream("audio.ogg"),
        model: "gpt-4o-mini-transcribe"
      });

      const texto = transcription.text;

      msg.reply(`🎤 Entendi: "${texto}"`);
      processarTexto(texto, msg);

    } catch (err) {
      msg.reply('❌ Erro ao processar áudio');
      console.error(err);
    }
  }
});

client.initialize();