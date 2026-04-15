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

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN não definido');
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não definido');
if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID não definido');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS não definido');

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET = 'Lancamentos';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: {
    autoStart: true,
    interval: 1000,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', async (error) => {
  console.error('Polling error:', error?.message || error);

  if (String(error?.message || '').includes('409')) {
    try {
      await bot.stopPolling();
      console.log('⚠️ Polling parado por conflito 409.');
    } catch (e) {
      console.error('Erro ao parar polling:', e);
    }
  }
});

function money(v) {
  return Number(v || 0).toFixed(2).replace('.', ',');
}

function clean(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\bleo\b/g, '')
    .replace(/r\$/g, '')
    .replace(/reais?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ensureSheet() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tab = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === SHEET
  );

  if (!tab) {
    throw new Error(`Aba "${SHEET}" não encontrada na planilha`);
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A1:G2`
  }).catch(() => ({ data: { values: [] } }));

  const values = res.data.values || [];
  const header = ['ID', 'Data', 'Tipo', 'Valor', 'Categoria', 'Descrição', 'Usuário'];

  if (!values.length || values[0].join('|') !== header.join('|')) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }
}

async function getRows() {
  await ensureSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A:G`
  });

  const rows = res.data.values || [];
  return rows.slice(1).map((r, i) => ({
    row: i + 2,
    id: Number(r[0] || 0),
    data: r[1] || '',
    tipo: (r[2] || '').toLowerCase(),
    valor: Number(String(r[3] || '0').replace(',', '.')),
    categoria: r[4] || 'geral',
    descricao: r[5] || '',
    usuario: r[6] || ''
  })).filter((r) => r.id && !Number.isNaN(r.valor));
}

async function add(tipo, valor, categoria, desc, usuario = '') {
  const rows = await getRows();
  const id = rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[id, new Date().toISOString(), tipo, Number(valor), categoria, desc, usuario]]
    }
  });

  return id;
}

async function updateCell(rowNumber, colLetter, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!${colLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
}

async function deleteRow(rowNumber) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === SHEET
  );
  if (!sheet) throw new Error(`Aba "${SHEET}" não encontrada`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber
            }
          }
        }
      ]
    }
  });
}

async function saldo() {
  const rows = await getRows();
  return rows.reduce((acc, r) => acc + (r.tipo === 'receita' ? r.valor : -r.valor), 0);
}

async function ultimos(limit = 5) {
  const rows = await getRows();
  return rows.sort((a, b) => b.id - a.id).slice(0, limit);
}

async function resumoMensal(categoriaFiltro = null) {
  const rows = await getRows();
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const filtered = rows.filter((r) => {
    const d = new Date(r.data);
    const sameMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` === ym;
    const sameCategory = !categoriaFiltro || (r.categoria || '').toLowerCase() === categoriaFiltro.toLowerCase();
    return sameMonth && sameCategory;
  });

  let gasto = 0;
  let receita = 0;
  const byCategory = {};

  for (const row of filtered) {
    if (row.tipo === 'gasto') {
      gasto += row.valor;
      byCategory[row.categoria] = (byCategory[row.categoria] || 0) + row.valor;
    } else if (row.tipo === 'receita') {
      receita += row.valor;
    }
  }

  let msg = '📊 Resumo do mês';
  if (categoriaFiltro) msg += ` (${categoriaFiltro})`;
  msg += `\n\n💸 Gastos: R$ ${money(gasto)}\n💰 Receitas: R$ ${money(receita)}\n🟰 Saldo: R$ ${money(receita - gasto)}\n\n`;

  const itens = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (!itens.length) return msg + 'Nenhum lançamento encontrado.';

  msg += 'Por categoria:\n';
  for (const [cat, valor] of itens) {
    msg += `• ${cat}: R$ ${money(valor)}\n`;
  }
  return msg;
}

async function resumoHoje() {
  const rows = await getRows();
  const now = new Date();

  const filtered = rows.filter((r) => {
    const d = new Date(r.data);
    return d.getUTCFullYear() === now.getUTCFullYear()
      && d.getUTCMonth() === now.getUTCMonth()
      && d.getUTCDate() === now.getUTCDate();
  });

  let gasto = 0;
  let receita = 0;

  for (const row of filtered) {
    if (row.tipo === 'gasto') gasto += row.valor;
    if (row.tipo === 'receita') receita += row.valor;
  }

  let msg = `📅 Hoje\n\n💸 Gastos: R$ ${money(gasto)}\n💰 Receitas: R$ ${money(receita)}\n🟰 Saldo: R$ ${money(receita - gasto)}\n`;
  if (!filtered.length) msg += '\nNenhum lançamento hoje.';
  return msg;
}

function interpretarRegra(texto) {
  const t = (texto || '').toLowerCase();
  const match = t.match(/\d+[.,]?\d*/);
  if (!match) return null;

  const valor = Number(match[0].replace(',', '.'));
  if (!valor) return null;

  const ehReceita = /(recebi|salario|salário|pix recebido|entrou|caiu|pagamento)/i.test(t);
  const ehGasto = /(gastei|abasteci|uber|mercado|paguei|comprei|ifood|restaurante|pizza|farmacia|posto|combustivel|combustível)/i.test(t);

  if (!ehReceita && !ehGasto) return null;

  let categoria = 'geral';

  if (/(abasteci|gasolina|combustivel|combustível|posto|etanol|diesel)/i.test(t)) categoria = 'combustivel';
  else if (/(uber|99|taxi|táxi|transporte|corrida)/i.test(t)) categoria = 'transporte';
  else if (/(mercado|supermercado|padaria|feira|hortifruti)/i.test(t)) categoria = 'mercado';
  else if (/(ifood|restaurante|pizza|jantar|almoco|almoço|lanche|comida)/i.test(t)) categoria = 'alimentacao';
  else if (/(farmacia|farmácia|remedio|remédio|medicamento)/i.test(t)) categoria = 'saude';
  else if (ehReceita) categoria = 'salario';

  return {
    eh: true,
    tipo: ehReceita ? 'receita' : 'gasto',
    valor,
    categoria
  };
}

async function interpretar(texto, tentativas = 4) {
  let ultimoErro;

  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `
Extraia JSON:
{ "eh": true/false, "tipo": "gasto|receita", "valor": number, "categoria": "string" }

Texto: ${texto}
`,
        config: {
          responseMimeType: 'application/json'
        }
      });

      return JSON.parse(res.text || '{}');
    } catch (err) {
      ultimoErro = err;
      const status = err?.status || err?.error?.code;
      const erroTemporario =
        status === 503 ||
        status === 429 ||
        String(err?.message || '').includes('high demand') ||
        String(err?.message || '').includes('UNAVAILABLE');

      if (!erroTemporario || i === tentativas - 1) {
        throw err;
      }

      const espera = 1500 * (i + 1);
      await new Promise((resolve) => setTimeout(resolve, espera));
    }
  }

  throw ultimoErro;
}

async function interpretarArquivoComGemini(filePath, mimeType, instrucoes, tentativas = 4) {
  let ultimoErro;

  for (let i = 0; i < tentativas; i++) {
    try {
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
        config: {
          responseMimeType: 'application/json'
        }
      });

      return JSON.parse(response.text || '{}');
    } catch (err) {
      ultimoErro = err;
      const status = err?.status || err?.error?.code;
      const erroTemporario =
        status === 503 ||
        status === 429 ||
        String(err?.message || '').includes('high demand') ||
        String(err?.message || '').includes('UNAVAILABLE');

      if (!erroTemporario || i === tentativas - 1) {
        throw err;
      }

      const espera = 1500 * (i + 1);
      await new Promise((resolve) => setTimeout(resolve, espera));
    }
  }

  throw ultimoErro;
}

async function baixarArquivoTelegram(fileId, destino) {
  const fileLink = await bot.getFileLink(fileId);
  const response = await axios.get(fileLink, {
    responseType: 'arraybuffer',
    timeout: 60000
  });
  fs.writeFileSync(destino, response.data);
}

app.get('/api', async (_req, res) => {
  try {
    const rows = await getRows();
    const gasto = rows.filter((r) => r.tipo === 'gasto').reduce((a, b) => a + b.valor, 0);
    const receita = rows.filter((r) => r.tipo === 'receita').reduce((a, b) => a + b.valor, 0);

    res.json({
      saldo: receita - gasto,
      gasto,
      receita,
      ultimos: rows.slice(-10).reverse()
    });
  } catch (e) {
    console.error('Erro API:', e);
    res.status(500).json({ error: e?.message || 'Erro interno' });
  }
});

app.listen(PORT, () => {
  console.log('📊 Dashboard rodando');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const usuario =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
    msg.from?.username ||
    '';

  try {
    if (msg.text) {
      const t = clean(msg.text);

      if (t === '/start' || t === 'start') {
        await bot.sendMessage(chatId, [
          'FinLeo PRO ativo 🚀',
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
          'Também aceita:',
          '• texto',
          '• áudio',
          '• imagem de recibo'
        ].join('\n'));
        return;
      }

      if (t === 'saldo') {
        const s = await saldo();
        await bot.sendMessage(chatId, `💰 R$ ${money(s)}`);
        return;
      }

      if (t === 'ultimos' || t === 'últimos') {
        const u = await ultimos();
        if (!u.length) {
          await bot.sendMessage(chatId, 'Nenhum lançamento encontrado.');
          return;
        }
        const txt = u.map((x) => `#${x.id} ${x.categoria} • R$ ${money(x.valor)} • ${x.descricao}`).join('\n');
        await bot.sendMessage(chatId, `🧾 Últimos lançamentos\n\n${txt}`);
        return;
      }

      if (t === 'hoje') {
        await bot.sendMessage(chatId, await resumoHoje());
        return;
      }

      if (t === 'resumo') {
        await bot.sendMessage(chatId, await resumoMensal());
        return;
      }

      if (t.startsWith('resumo ')) {
        const categoria = t.replace('resumo ', '').trim();
        await bot.sendMessage(chatId, await resumoMensal(categoria));
        return;
      }

      if (t === 'apagar' || t === 'apagar ultimo' || t === 'apagar último') {
        const u = await ultimos(1);
        if (!u.length) {
          await bot.sendMessage(chatId, 'Nenhum lançamento para apagar.');
          return;
        }
        await deleteRow(u[0].row);
        await bot.sendMessage(chatId, `🗑️ Lançamento #${u[0].id} apagado.`);
        return;
      }

      if (t.startsWith('editar valor')) {
        const match = t.match(/\d+[.,]?\d*/);
        const novoValor = match ? Number(match[0].replace(',', '.')) : null;

        if (!novoValor) {
          await bot.sendMessage(chatId, 'Use: editar valor 120');
          return;
        }

        const u = await ultimos(1);
        if (!u.length) {
          await bot.sendMessage(chatId, 'Nenhum lançamento para editar.');
          return;
        }

        await updateCell(u[0].row, 'D', novoValor);
        await bot.sendMessage(chatId, `✏️ Valor do lançamento #${u[0].id} atualizado para R$ ${money(novoValor)}.`);
        return;
      }

      if (t.startsWith('editar categoria')) {
        const categoria = t.replace('editar categoria', '').trim();

        if (!categoria) {
          await bot.sendMessage(chatId, 'Use: editar categoria transporte');
          return;
        }

        const u = await ultimos(1);
        if (!u.length) {
          await bot.sendMessage(chatId, 'Nenhum lançamento para editar.');
          return;
        }

        await updateCell(u[0].row, 'E', categoria);
        await bot.sendMessage(chatId, `✏️ Categoria do lançamento #${u[0].id} atualizada para ${categoria}.`);
        return;
      }

      const tentativaRegra = interpretarRegra(msg.text);

      if (tentativaRegra) {
        await add(tentativaRegra.tipo, tentativaRegra.valor, tentativaRegra.categoria || 'geral', msg.text, usuario);
        const s = await saldo();
        await bot.sendMessage(
          chatId,
          `✔️ R$ ${money(tentativaRegra.valor)} (${tentativaRegra.categoria})\nSaldo: R$ ${money(s)}`
        );
        return;
      }

      const dados = await interpretar(msg.text);

      if (dados.eh && dados.valor) {
        await add(dados.tipo, dados.valor, dados.categoria || 'geral', msg.text, usuario);
        const s = await saldo();
        await bot.sendMessage(chatId, `✔️ R$ ${money(dados.valor)} (${dados.categoria})\nSaldo: R$ ${money(s)}`);
        return;
      }

      await bot.sendMessage(chatId, 'Não entendi');
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
  "eh": true,
  "tipo": "gasto|receita|null",
  "valor": number|null,
  "categoria": "string|null",
  "texto_transcrito": "string|null"
}
Se não for um lançamento financeiro, responda:
{"eh": false, "tipo": null, "valor": null, "categoria": null, "texto_transcrito": "texto" }`
      );

      if (dados.texto_transcrito) {
        await bot.sendMessage(chatId, `🎤 Entendi: "${dados.texto_transcrito}"`);
      }

      if (dados.eh && dados.valor) {
        await add(dados.tipo, dados.valor, dados.categoria || 'geral', dados.texto_transcrito || 'áudio', usuario);
        const s = await saldo();
        await bot.sendMessage(chatId, `✔️ R$ ${money(dados.valor)} (${dados.categoria})\nSaldo: R$ ${money(s)}`);
        return;
      }

      await bot.sendMessage(chatId, 'Não consegui identificar um lançamento nesse áudio.');
      return;
    }

    if (msg.photo && msg.photo.length > 0) {
      const maior = msg.photo[msg.photo.length - 1];
      const filePath = '/tmp/telegram_photo.jpg';
      await baixarArquivoTelegram(maior.file_id, filePath);

      const dados = await interpretarArquivoComGemini(
        filePath,
        'image/jpeg',
        `Analise esta imagem de recibo, nota, comprovante ou foto relacionada a gasto.
Responda apenas JSON válido com:
{
  "eh": true,
  "tipo": "gasto|receita|null",
  "valor": number|null,
  "categoria": "string|null",
  "descricao": "string|null"
}
Se não houver lançamento identificável, responda:
{"eh": false, "tipo": null, "valor": null, "categoria": null, "descricao": null}`
      );

      if (dados.eh && dados.valor) {
        await add(dados.tipo, dados.valor, dados.categoria || 'geral', dados.descricao || 'imagem', usuario);
        const s = await saldo();
        await bot.sendMessage(chatId, `✔️ R$ ${money(dados.valor)} (${dados.categoria})\nSaldo: R$ ${money(s)}`);
        return;
      }

      await bot.sendMessage(chatId, 'Não consegui identificar um lançamento nessa imagem.');
      return;
    }

    await bot.sendMessage(chatId, 'Envie texto, áudio ou imagem.');
  } catch (e) {
    console.error('ERRO COMPLETO:', e);

    const mensagem = String(e?.message || '');

    if (
      e?.status === 503 ||
      mensagem.includes('high demand') ||
      mensagem.includes('UNAVAILABLE')
    ) {
      await bot.sendMessage(chatId, '⚠️ O Gemini está com alta demanda agora. Tente novamente em alguns segundos.');
      return;
    }

    const erroMsg =
      e?.message ||
      e?.response?.data?.error?.message ||
      'Erro interno';

    await bot.sendMessage(chatId, `❌ ${erroMsg}`);
  }
});

console.log('✅ FinLeo PRO iniciado');
