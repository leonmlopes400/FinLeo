
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
const PORT = Number(process.env.PORT || 3000);

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN não definido.');
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não definido.');
if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID não definido.');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS não definido.');

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_NAME = 'Lancamentos';
const HEADER = ['ID', 'Data', 'Tipo', 'Valor', 'Categoria', 'Descrição', 'Usuário'];

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const app = express();

function formatMoney(value) {
  return Number(value || 0).toFixed(2).replace('.', ',');
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\bleo\b/gi, '')
    .replace(/\bfinleo\b/gi, '')
    .replace(/\breais?\b/gi, '')
    .replace(/\br\$\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCategory(text) {
  return (text || 'geral')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .trim() || 'geral';
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function ensureSheet() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:G2`
  }).catch(async (err) => {
    // Sheet may not exist yet; create it.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const exists = (meta.data.sheets || []).some(s => s.properties && s.properties.title === SHEET_NAME);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
        }
      });
    }
    return { data: { values: [] } };
  });

  const values = res.data.values || [];
  if (!values.length || values[0].join('|') !== HEADER.join('|')) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] }
    });
  }
}

async function getRows() {
  await ensureSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:G`
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1).map((r, index) => ({
    rowNumber: index + 2,
    id: Number(r[0] || 0),
    data: r[1] || '',
    tipo: (r[2] || '').toLowerCase(),
    valor: Number(String(r[3] || '0').replace(',', '.')),
    categoria: r[4] || 'geral',
    descricao: r[5] || '',
    usuario: r[6] || ''
  })).filter(r => r.id && !Number.isNaN(r.valor));
}

async function appendLancamento(tipo, valor, categoria, descricao, usuario) {
  const rows = await getRows();
  const nextId = rows.length ? Math.max(...rows.map(r => r.id)) + 1 : 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        nextId,
        new Date().toISOString(),
        tipo,
        Number(valor),
        normalizeCategory(categoria),
        descricao,
        usuario || ''
      ]]
    }
  });

  return nextId;
}

async function updateCell(rowNumber, colLetter, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
}

async function deleteRow(rowNumber) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === SHEET_NAME);
  if (!sheet) throw new Error('Aba Lancamentos não encontrada.');

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber
          }
        }
      }]
    }
  });
}

async function calcularSaldo() {
  const rows = await getRows();
  return rows.reduce((acc, r) => acc + (r.tipo === 'receita' ? r.valor : -r.valor), 0);
}

async function resumoMensal(categoryFilter = null, date = new Date()) {
  const rows = await getRows();
  const currentMonth = monthKey(date);
  const filtered = rows.filter(r => {
    const d = new Date(r.data);
    const sameMonth = monthKey(d) === currentMonth;
    const categoryOk = !categoryFilter || normalizeCategory(r.categoria) === normalizeCategory(categoryFilter);
    return sameMonth && categoryOk;
  });

  let totalGasto = 0;
  let totalReceita = 0;
  const categorias = {};

  for (const row of filtered) {
    if (row.tipo === 'gasto') {
      totalGasto += row.valor;
      categorias[row.categoria] = (categorias[row.categoria] || 0) + row.valor;
    } else if (row.tipo === 'receita') {
      totalReceita += row.valor;
    }
  }

  let texto = `📊 Resumo do mês`;
  if (categoryFilter) texto += ` (${normalizeCategory(categoryFilter)})`;
  texto += `\n\n💸 Gastos: R$ ${formatMoney(totalGasto)}\n💰 Receitas: R$ ${formatMoney(totalReceita)}\n🟰 Saldo: R$ ${formatMoney(totalReceita - totalGasto)}\n\n`;

  const itens = Object.entries(categorias).sort((a, b) => b[1] - a[1]);
  if (!itens.length) return texto + 'Nenhum lançamento encontrado.';

  texto += 'Por categoria:\n';
  for (const [cat, valor] of itens) {
    texto += `• ${cat}: R$ ${formatMoney(valor)}\n`;
  }
  return texto;
}

async function resumoHoje() {
  const rows = await getRows();
  const hoje = new Date();
  const yyyy = hoje.getUTCFullYear();
  const mm = hoje.getUTCMonth();
  const dd = hoje.getUTCDate();

  const filtered = rows.filter(r => {
    const d = new Date(r.data);
    return d.getUTCFullYear() === yyyy && d.getUTCMonth() === mm && d.getUTCDate() === dd;
  });

  let gasto = 0;
  let receita = 0;
  for (const row of filtered) {
    if (row.tipo === 'gasto') gasto += row.valor;
    if (row.tipo === 'receita') receita += row.valor;
  }

  let msg = `📅 Hoje\n\n💸 Gastos: R$ ${formatMoney(gasto)}\n💰 Receitas: R$ ${formatMoney(receita)}\n🟰 Saldo: R$ ${formatMoney(receita - gasto)}\n`;
  if (!filtered.length) msg += '\nNenhum lançamento hoje.';
  return msg;
}

async function ultimosLancamentos(limit = 5) {
  const rows = await getRows();
  return rows.sort((a, b) => b.id - a.id).slice(0, limit);
}

async function interpretarComGeminiTexto(textoOriginal) {
  const texto = normalizeText(textoOriginal);
  const prompt = `
Você extrai dados financeiros de mensagens curtas em português.
Responda apenas JSON válido com as chaves:
{
  "eh_lancamento": boolean,
  "tipo": "gasto" | "receita" | null,
  "valor": number | null,
  "categoria": string | null
}

Regras:
- Se for gasto, use tipo "gasto"
- Se for receita, use tipo "receita"
- Categorias curtas, minúsculas e sem acento, como:
  combustivel, mercado, alimentacao, transporte, saude, casa, lazer, compras, salario, geral
- Se não for lançamento financeiro, retorne eh_lancamento=false
- Não escreva explicações

Mensagem:
${texto}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json' }
  });

  const parsed = JSON.parse(response.text || '{}');
  return {
    eh_lancamento: Boolean(parsed.eh_lancamento),
    tipo: parsed.tipo || null,
    valor: parsed.valor != null ? Number(parsed.valor) : null,
    categoria: parsed.categoria ? normalizeCategory(parsed.categoria) : null
  };
}

async function interpretarArquivoComGemini(filePath, mimeType, instrucoes) {
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType }
  });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: createUserContent([
      instrucoes,
      createPartFromUri(uploaded.uri, uploaded.mimeType)
    ]),
    config: { responseMimeType: 'application/json' }
  });

  return JSON.parse(response.text || '{}');
}

async function baixarArquivoTelegram(fileId, destino) {
  const link = await bot.getFileLink(fileId);
  const response = await axios.get(link, { responseType: 'arraybuffer', timeout: 60000 });
  fs.writeFileSync(destino, response.data);
}

function helpText() {
  return [
    '👋 FinLeo Pro está pronto.',
    '',
    'Comandos:',
    '• saldo',
    '• resumo',
    '• resumo mercado',
    '• hoje',
    '• ultimos',
    '• editar valor 120',
    '• editar categoria transporte',
    '• apagar',
    '',
    'Você também pode enviar:',
    '• texto: "leo gastei 140 reais"',
    '• áudio',
    '• imagem de recibo'
  ].join('\n');
}

async function processarLancamento(dados, descricao, chatId, usuario) {
  if (!(dados && dados.eh_lancamento && dados.tipo && dados.valor)) {
    await bot.sendMessage(chatId, 'Não entendi. Exemplos:\n• gastei 50 mercado\n• abasteci 150 de combustível\n• recebi 2000 de salário\n• ultimos\n• editar valor 120');
    return;
  }

  await appendLancamento(dados.tipo, dados.valor, dados.categoria || 'geral', descricao, usuario);
  const saldo = await calcularSaldo();
  const emoji = dados.tipo === 'receita' ? '✅' : '💸';
  const label = dados.tipo === 'receita' ? 'Receita registrada' : 'Gasto registrado';

  await bot.sendMessage(chatId, `${emoji} ${label}!\nR$ ${formatMoney(dados.valor)} em ${normalizeCategory(dados.categoria || 'geral')}\n💰 Saldo: R$ ${formatMoney(saldo)}`);
}

function extractEditValue(command) {
  const match = command.match(/\d+[.,]?\d*/);
  return match ? Number(match[0].replace(',', '.')) : null;
}

async function handleCommand(text, chatId, usuario) {
  const t = normalizeText(text);

  if (t === '/start' || t === 'start') {
    await bot.sendMessage(chatId, helpText());
    return true;
  }

  if (t === 'saldo' || t.includes('saldo atual')) {
    const saldo = await calcularSaldo();
    await bot.sendMessage(chatId, `💰 Saldo atual: R$ ${formatMoney(saldo)}`);
    return true;
  }

  if (t === 'hoje') {
    await bot.sendMessage(chatId, await resumoHoje());
    return true;
  }

  if (t === 'ultimos' || t === 'últimos') {
    const ultimos = await ultimosLancamentos(5);
    if (!ultimos.length) {
      await bot.sendMessage(chatId, 'Nenhum lançamento encontrado.');
      return true;
    }
    const msg = ultimos.map((r, idx) => `${idx + 1}. #${r.id} • ${r.tipo} • R$ ${formatMoney(r.valor)} • ${r.categoria} • ${r.descricao}`).join('\n');
    await bot.sendMessage(chatId, `🧾 Últimos lançamentos\n\n${msg}`);
    return true;
  }

  if (t === 'apagar' || t === 'apagar ultimo' || t === 'apagar último') {
    const ultimos = await ultimosLancamentos(1);
    if (!ultimos.length) {
      await bot.sendMessage(chatId, 'Nenhum lançamento para apagar.');
      return true;
    }
    await deleteRow(ultimos[0].rowNumber);
    await bot.sendMessage(chatId, `🗑️ Lançamento #${ultimos[0].id} apagado.`);
    return true;
  }

  if (t.startsWith('editar valor')) {
    const novoValor = extractEditValue(t);
    if (!novoValor) {
      await bot.sendMessage(chatId, 'Use: editar valor 120');
      return true;
    }
    const ultimos = await ultimosLancamentos(1);
    if (!ultimos.length) {
      await bot.sendMessage(chatId, 'Nenhum lançamento para editar.');
      return true;
    }
    await updateCell(ultimos[0].rowNumber, 'D', novoValor);
    await bot.sendMessage(chatId, `✏️ Valor do lançamento #${ultimos[0].id} atualizado para R$ ${formatMoney(novoValor)}.`);
    return true;
  }

  if (t.startsWith('editar categoria')) {
    const novaCategoria = normalizeCategory(t.replace('editar categoria', '').trim());
    if (!novaCategoria || novaCategoria === 'geral' && !t.replace('editar categoria', '').trim()) {
      await bot.sendMessage(chatId, 'Use: editar categoria transporte');
      return true;
    }
    const ultimos = await ultimosLancamentos(1);
    if (!ultimos.length) {
      await bot.sendMessage(chatId, 'Nenhum lançamento para editar.');
      return true;
    }
    await updateCell(ultimos[0].rowNumber, 'E', novaCategoria);
    await bot.sendMessage(chatId, `✏️ Categoria do lançamento #${ultimos[0].id} atualizada para ${novaCategoria}.`);
    return true;
  }

  if (t === 'resumo') {
    await bot.sendMessage(chatId, await resumoMensal());
    return true;
  }

  if (t.startsWith('resumo ')) {
    const category = t.replace('resumo ', '').trim();
    await bot.sendMessage(chatId, await resumoMensal(category));
    return true;
  }

  return false;
}

// Dashboard API
app.use(express.static(path.join(__dirname, 'public'))));

app.get('/api/summary', async (_req, res) => {
  try {
    const rows = await getRows();
    const now = new Date();
    const mk = monthKey(now);

    let totalGasto = 0;
    let totalReceita = 0;
    const byCategory = {};
    const byDay = {};

    for (const row of rows) {
      const d = new Date(row.data);
      const day = d.toISOString().slice(0, 10);

      if (row.tipo === 'gasto') {
        byDay[day] = (byDay[day] || 0) + row.valor;
      }

      if (monthKey(d) === mk) {
        if (row.tipo === 'gasto') {
          totalGasto += row.valor;
          byCategory[row.categoria] = (byCategory[row.categoria] || 0) + row.valor;
        } else if (row.tipo === 'receita') {
          totalReceita += row.valor;
        }
      }
    }

    const latest = rows.sort((a, b) => b.id - a.id).slice(0, 10);

    res.json({
      saldoAtual: rows.reduce((acc, r) => acc + (r.tipo === 'receita' ? r.valor : -r.valor), 0),
      totalGastoMes: totalGasto,
      totalReceitaMes: totalReceita,
      saldoMes: totalReceita - totalGasto,
      byCategory,
      byDay,
      latest
    });
  } catch (error) {
    console.error('Erro API summary:', error);
    res.status(500).json({ error: 'Erro ao gerar dashboard.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`📊 Dashboard rodando na porta ${PORT}`);
});

// Telegram
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const usuario = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || '';

  try {
    if (msg.text) {
      const handled = await handleCommand(msg.text, chatId, usuario);
      if (handled) return;

      const dados = await interpretarComGeminiTexto(msg.text);
      await processarLancamento(dados, msg.text, chatId, usuario);
      return;
    }

    if (msg.voice) {
      const filePath = '/tmp/telegram_voice.ogg';
      await baixarArquivoTelegram(msg.voice.file_id, filePath);

      const dados = await interpretarArquivoComGemini(
        filePath,
        'audio/ogg',
        `Transcreva e interprete este áudio em português.
Responda apenas JSON válido com:
{
  "eh_lancamento": boolean,
  "tipo": "gasto" | "receita" | null,
  "valor": number | null,
  "categoria": string | null,
  "texto_transcrito": string | null
}
Se não for lançamento financeiro, retorne eh_lancamento=false.`
      );

      if (dados.texto_transcrito) {
        await bot.sendMessage(chatId, `🎤 Entendi: "${dados.texto_transcrito}"`);
      }
      await processarLancamento(dados, dados.texto_transcrito || 'áudio', chatId, usuario);
      return;
    }

    if (msg.photo && msg.photo.length) {
      const maior = msg.photo[msg.photo.length - 1];
      const filePath = '/tmp/telegram_photo.jpg';
      await baixarArquivoTelegram(maior.file_id, filePath);

      const dados = await interpretarArquivoComGemini(
        filePath,
        'image/jpeg',
        `Analise esta imagem de recibo, nota, comprovante ou foto relacionada a gasto.
Responda apenas JSON válido com:
{
  "eh_lancamento": boolean,
  "tipo": "gasto" | "receita" | null,
  "valor": number | null,
  "categoria": string | null,
  "descricao": string | null
}
Se não houver valor identificável, retorne eh_lancamento=false.`
      );

      await processarLancamento(dados, dados.descricao || 'imagem', chatId, usuario);
      return;
    }

    await bot.sendMessage(chatId, 'Envie texto, áudio ou imagem.');
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    await bot.sendMessage(chatId, '❌ Ocorreu um erro ao processar sua mensagem.');
  }
});

console.log('✅ FinLeo Pro iniciado.');
