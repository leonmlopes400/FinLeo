const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');
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

const LANCAMENTOS_SHEET = 'Lancamentos';
const METAS_SHEET = 'Metas';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: {
    autoStart: true,
    interval: 1000,
    params: { timeout: 10 }
  }
});

const pendingDelete = new Map();
let lancamentosCache = { data: null, ts: 0 };
let metasCache = { data: null, ts: 0 };
const CACHE_MS = 60000;

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

function normalizeCategory(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseMonthRef(text) {
  const t = clean(text);
  const now = new Date();
  const months = {
    janeiro: 0, fevereiro: 1, marco: 2, março: 2, abril: 3, maio: 4, junho: 5,
    julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11
  };

  if (t.includes('mes passado') || t.includes('mês passado')) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  }

  const yearMatch = t.match(/20\d{2}/);
  const year = yearMatch ? Number(yearMatch[0]) : now.getUTCFullYear();

  for (const [name, idx] of Object.entries(months)) {
    if (t.includes(name)) {
      return new Date(Date.UTC(year, idx, 1));
    }
  }

  return now;
}

async function ensureSheet(sheetName, header) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tab = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === sheetName
  );

  if (!tab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      }
    });
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:Z2`
  }).catch(() => ({ data: { values: [] } }));

  const values = res.data.values || [];
  const currentHeader = values[0] || [];

  if (header.join('|') !== currentHeader.join('|')) {
    const endCol = String.fromCharCode(64 + header.length);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:${endCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }
}

async function bootstrapSheets() {
  await ensureSheet(LANCAMENTOS_SHEET, ['ID', 'Data', 'Tipo', 'Valor', 'Categoria', 'Descrição', 'Usuário']);
  await ensureSheet(METAS_SHEET, ['Categoria', 'Valor']);
}

async function getSheetValues(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  return res.data.values || [];
}

async function getLancamentos(force = false) {
  if (!force && lancamentosCache.data && Date.now() - lancamentosCache.ts < CACHE_MS) {
    return lancamentosCache.data;
  }

  const rows = await getSheetValues(`${LANCAMENTOS_SHEET}!A:G`);
  const parsed = rows.slice(1).map((r, i) => ({
    row: i + 2,
    id: Number(r[0] || 0),
    data: r[1] || '',
    tipo: (r[2] || '').toLowerCase(),
    valor: Number(String(r[3] || '0').replace(',', '.')),
    categoria: r[4] || 'geral',
    descricao: r[5] || '',
    usuario: r[6] || ''
  })).filter((r) => r.id && !Number.isNaN(r.valor));

  lancamentosCache = { data: parsed, ts: Date.now() };
  return parsed;
}

async function getMetas(force = false) {
  if (!force && metasCache.data && Date.now() - metasCache.ts < CACHE_MS) {
    return metasCache.data;
  }

  const rows = await getSheetValues(`${METAS_SHEET}!A:B`);
  const parsed = rows.slice(1).map((r, i) => ({
    row: i + 2,
    categoria: normalizeCategory(r[0] || ''),
    valor: Number(String(r[1] || '0').replace(',', '.'))
  })).filter((r) => r.categoria && !Number.isNaN(r.valor));

  metasCache = { data: parsed, ts: Date.now() };
  return parsed;
}

async function setMeta(categoria, valor) {
  const metas = await getMetas();
  const cat = normalizeCategory(categoria);
  const existente = metas.find((m) => m.categoria === cat);

  if (existente) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${METAS_SHEET}!B${existente.row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[Number(valor)]] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${METAS_SHEET}!A:B`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[cat, Number(valor)]] }
    });
  }

  metasCache = { data: null, ts: 0 };
}

async function add(tipo, valor, categoria, desc, usuario = '') {
  const rows = await getLancamentos();
  const id = rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${LANCAMENTOS_SHEET}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[id, new Date().toISOString(), tipo, Number(valor), normalizeCategory(categoria), desc, usuario]]
    }
  });

  lancamentosCache = { data: null, ts: 0 };
  return id;
}

async function updateCell(rowNumber, colLetter, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${LANCAMENTOS_SHEET}!${colLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
  lancamentosCache = { data: null, ts: 0 };
}

async function deleteRow(rowNumber) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === LANCAMENTOS_SHEET
  );
  if (!sheet) throw new Error(`Aba "${LANCAMENTOS_SHEET}" não encontrada`);

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

  lancamentosCache = { data: null, ts: 0 };
}

async function saldo() {
  const rows = await getLancamentos();
  return rows.reduce((acc, r) => acc + (r.tipo === 'receita' ? r.valor : -r.valor), 0);
}

async function ultimos(limit = 5) {
  const rows = await getLancamentos();
  return rows.sort((a, b) => b.id - a.id).slice(0, limit);
}

async function findById(id) {
  const rows = await getLancamentos();
  return rows.find((r) => r.id === Number(id)) || null;
}

async function gastosPorCategoriaMes(refDate = new Date()) {
  const rows = await getLancamentos();
  const ym = monthKey(refDate);
  const totals = {};

  for (const row of rows) {
    const d = new Date(row.data);
    if (row.tipo === 'gasto' && monthKey(d) === ym) {
      const cat = normalizeCategory(row.categoria);
      totals[cat] = (totals[cat] || 0) + row.valor;
    }
  }

  return totals;
}

async function metasStatus(refDate = new Date()) {
  const metas = await getMetas();
  const gastos = await gastosPorCategoriaMes(refDate);

  return metas.map((meta) => {
    const gasto = gastos[meta.categoria] || 0;
    const percentual = meta.valor > 0 ? (gasto / meta.valor) * 100 : 0;
    return {
      categoria: meta.categoria,
      meta: meta.valor,
      gasto,
      percentual
    };
  }).sort((a, b) => b.percentual - a.percentual);
}

async function resumoMensal(categoriaFiltro = null, refDate = new Date()) {
  const rows = await getLancamentos();
  const ym = monthKey(refDate);

  const filtered = rows.filter((r) => {
    const d = new Date(r.data);
    const sameMonth = monthKey(d) === ym;
    const sameCategory = !categoriaFiltro || normalizeCategory(r.categoria) === normalizeCategory(categoriaFiltro);
    return sameMonth && sameCategory;
  });

  let gasto = 0;
  let receita = 0;
  const byCategory = {};

  for (const row of filtered) {
    if (row.tipo === 'gasto') {
      gasto += row.valor;
      const cat = normalizeCategory(row.categoria);
      byCategory[cat] = (byCategory[cat] || 0) + row.valor;
    } else if (row.tipo === 'receita') {
      receita += row.valor;
    }
  }

  let msg = `📊 Resumo de ${ym}`;
  if (categoriaFiltro) msg += ` (${normalizeCategory(categoriaFiltro)})`;
  msg += `\n\n💸 Gastos: R$ ${money(gasto)}\n💰 Receitas: R$ ${money(receita)}\n🟰 Saldo: R$ ${money(receita - gasto)}\n\n`;

  const itens = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (!itens.length) return msg + 'Nenhum lançamento encontrado.';

  msg += 'Por categoria:\n';
  for (const [cat, valor] of itens) {
    msg += `• ${cat}: R$ ${money(valor)}\n`;
  }

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
        config: { responseMimeType: 'application/json' }
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

      await new Promise((resolve) => setTimeout(resolve, 1500 * (i + 1)));
    }
  }

  throw ultimoErro;
}

async function checkMetaAlert(categoria, refDate = new Date()) {
  const status = await metasStatus(refDate);
  const cat = normalizeCategory(categoria);
  const meta = status.find((m) => m.categoria === cat);

  if (!meta) return null;
  if (meta.percentual >= 100) return `🚨 Meta de ${cat} excedida: R$ ${money(meta.gasto)} de R$ ${money(meta.meta)} (${meta.percentual.toFixed(0)}%)`;
  if (meta.percentual >= 80) return `⚠️ Meta de ${cat} em ${meta.percentual.toFixed(0)}%: R$ ${money(meta.gasto)} de R$ ${money(meta.meta)}`;
  return null;
}

app.get('/api', async (req, res) => {
  try {
    const month = req.query.month || monthKey(new Date());
    const category = req.query.category ? normalizeCategory(req.query.category) : null;
    const rows = await getLancamentos();

    const filtered = rows.filter((r) => {
      const d = new Date(r.data);
      const sameMonth = monthKey(d) === month;
      const sameCategory = !category || normalizeCategory(r.categoria) === category;
      return sameMonth && sameCategory;
    });

    const gasto = filtered.filter((r) => r.tipo === 'gasto').reduce((a, b) => a + b.valor, 0);
    const receita = filtered.filter((r) => r.tipo === 'receita').reduce((a, b) => a + b.valor, 0);

    const byCategory = {};
    const byDay = {};

    for (const row of filtered) {
      if (row.tipo === 'gasto') {
        const cat = normalizeCategory(row.categoria);
        byCategory[cat] = (byCategory[cat] || 0) + row.valor;
        const day = new Date(row.data).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + row.valor;
      }
    }

    res.json({
      month,
      category,
      saldo: receita - gasto,
      gasto,
      receita,
      ultimos: filtered.sort((a, b) => b.id - a.id).slice(0, 10),
      byCategory,
      byDay,
      metas: await metasStatus(new Date(`${month}-01T00:00:00Z`))
    });
  } catch (e) {
    console.error('Erro API:', e);
    res.status(500).json({ error: e?.message || 'Erro interno' });
  }
});

app.listen(PORT, () => {
  console.log(`📊 Dashboard rodando na porta ${PORT}`);
});

(async () => {
  await bootstrapSheets();
  console.log('✅ Abas verificadas');
})().catch((e) => {
  console.error('Erro no bootstrap:', e);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const usuario =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
    msg.from?.username ||
    '';

  try {
    if (!msg.text) {
      await bot.sendMessage(chatId, 'Envie texto.');
      return;
    }

    const t = clean(msg.text);

    if (pendingDelete.has(chatId) && (t === 'sim' || t === 'nao' || t === 'não')) {
      const targetId = pendingDelete.get(chatId);
      pendingDelete.delete(chatId);

      if (t === 'nao' || t === 'não') {
        await bot.sendMessage(chatId, '✅ Exclusão cancelada.');
        return;
      }

      const alvo = await findById(targetId);
      if (!alvo) {
        await bot.sendMessage(chatId, `❌ Lançamento #${targetId} não encontrado.`);
        return;
      }

      await deleteRow(alvo.row);
      await bot.sendMessage(chatId, `🗑️ Lançamento #${targetId} apagado.`);
      return;
    }

    if (t === '/start' || t === 'start') {
      await bot.sendMessage(chatId, [
        'FinLeo PRO ativo 🚀',
        '',
        'Comandos:',
        '• saldo',
        '• resumo',
        '• resumo mercado',
        '• mes passado',
        '• resumo janeiro',
        '• ultimos',
        '• editar 12 valor 120',
        '• editar 12 categoria transporte',
        '• apagar 12',
        '• meta mercado 800',
        '• metas',
        '',
        'Todo lançamento novo volta com o ID.'
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

    if (t === 'metas') {
      const status = await metasStatus();
      if (!status.length) {
        await bot.sendMessage(chatId, 'Nenhuma meta cadastrada.');
        return;
      }
      const txt = status.map((m) => `• ${m.categoria}: R$ ${money(m.gasto)} / R$ ${money(m.meta)} (${m.percentual.toFixed(0)}%)`).join('\n');
      await bot.sendMessage(chatId, `🎯 Metas do mês\n\n${txt}`);
      return;
    }

    if (t.startsWith('meta ')) {
      const match = t.match(/^meta\s+(.+?)\s+(\d+[.,]?\d*)$/);
      if (!match) {
        await bot.sendMessage(chatId, 'Use: meta mercado 800');
        return;
      }
      const categoria = normalizeCategory(match[1]);
      const valor = Number(match[2].replace(',', '.'));
      await setMeta(categoria, valor);
      await bot.sendMessage(chatId, `🎯 Meta salva\n${categoria}: R$ ${money(valor)}`);
      return;
    }

    if (t === 'mes passado' || t === 'mês passado') {
      await bot.sendMessage(chatId, await resumoMensal(null, parseMonthRef(t)));
      return;
    }

    if (t === 'resumo') {
      await bot.sendMessage(chatId, await resumoMensal());
      return;
    }

    if (t.startsWith('resumo ')) {
      const refDate = parseMonthRef(t);
      const monthWords = ['janeiro','fevereiro','marco','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro','mes passado','mês passado'];
      const categoria = monthWords.some((w) => t.includes(w)) ? null : t.replace('resumo ', '').trim();
      await bot.sendMessage(chatId, await resumoMensal(categoria, refDate));
      return;
    }

    if (t.startsWith('apagar ')) {
      const match = t.match(/\d+/);
      const id = match ? Number(match[0]) : null;
      if (!id) {
        await bot.sendMessage(chatId, 'Use: apagar 12');
        return;
      }
      const alvo = await findById(id);
      if (!alvo) {
        await bot.sendMessage(chatId, `❌ Lançamento #${id} não encontrado.`);
        return;
      }
      pendingDelete.set(chatId, id);
      await bot.sendMessage(chatId, `⚠️ Confirma apagar o lançamento #${id}? Responda: sim ou não`);
      return;
    }

    if (t.startsWith('editar ')) {
      const idMatch = t.match(/^editar\s+(\d+)/);
      if (!idMatch) {
        await bot.sendMessage(chatId, 'Use: editar 12 valor 120 ou editar 12 categoria transporte');
        return;
      }

      const id = Number(idMatch[1]);
      const alvo = await findById(id);
      if (!alvo) {
        await bot.sendMessage(chatId, `❌ Lançamento #${id} não encontrado.`);
        return;
      }

      if (t.includes(' valor ')) {
        const valueMatch = t.match(/\d+[.,]?\d*$/);
        const novoValor = valueMatch ? Number(valueMatch[0].replace(',', '.')) : null;

        if (!novoValor) {
          await bot.sendMessage(chatId, 'Use: editar 12 valor 120');
          return;
        }

        await updateCell(alvo.row, 'D', novoValor);
        await bot.sendMessage(chatId, `✏️ Lançamento #${id} atualizado.\nNovo valor: R$ ${money(novoValor)}`);
        return;
      }

      if (t.includes(' categoria ')) {
        const novaCategoria = t.split(' categoria ')[1]?.trim();
        if (!novaCategoria) {
          await bot.sendMessage(chatId, 'Use: editar 12 categoria transporte');
          return;
        }

        const cat = normalizeCategory(novaCategoria);
        await updateCell(alvo.row, 'E', cat);
        await bot.sendMessage(chatId, `✏️ Lançamento #${id} atualizado.\nNova categoria: ${cat}`);
        return;
      }

      await bot.sendMessage(chatId, 'Use: editar 12 valor 120 ou editar 12 categoria transporte');
      return;
    }

    const tentativaRegra = interpretarRegra(msg.text);

    if (tentativaRegra) {
      const newId = await add(tentativaRegra.tipo, tentativaRegra.valor, tentativaRegra.categoria || 'geral', msg.text, usuario);
      const s = await saldo();
      let resposta = `✔️ Lançamento #${newId} registrado\nR$ ${money(tentativaRegra.valor)} (${tentativaRegra.categoria})\nSaldo: R$ ${money(s)}`;
      if (tentativaRegra.tipo === 'gasto') {
        const alerta = await checkMetaAlert(tentativaRegra.categoria);
        if (alerta) resposta += `\n\n${alerta}`;
      }
      await bot.sendMessage(chatId, resposta);
      return;
    }

    const dados = await interpretar(msg.text);

    if (dados.eh && dados.valor) {
      const categoria = normalizeCategory(dados.categoria || 'geral');
      const newId = await add(dados.tipo, dados.valor, categoria, msg.text, usuario);
      const s = await saldo();
      let resposta = `✔️ Lançamento #${newId} registrado\nR$ ${money(dados.valor)} (${categoria})\nSaldo: R$ ${money(s)}`;
      if (dados.tipo === 'gasto') {
        const alerta = await checkMetaAlert(categoria);
        if (alerta) resposta += `\n\n${alerta}`;
      }
      await bot.sendMessage(chatId, resposta);
      return;
    }

    await bot.sendMessage(chatId, 'Não entendi');
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

    const msgErro =
      e?.message ||
      e?.response?.data?.error?.message ||
      'Erro interno';

    await bot.sendMessage(chatId, `❌ ${msgErro}`);
  }
});

console.log('✅ FinLeo PRO iniciado');
