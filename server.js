const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 8085;
const DATA_FILE = path.join(__dirname, 'data.json');
const API_KEY = process.env.MEMO_KEY || 'memo-luna-2026';

app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Auth for REST API
function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 初始化数据文件
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ notes: [], groups: [], trash: [], updatedAt: 0 }));
}

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeData(data) {
  data.updatedAt = Date.now();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── REST API ─────────────────────────────────────────────────────────
app.get('/api/data', auth, (req, res) => {
  try { res.json({ ok: true, data: readData() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data', auth, (req, res) => {
  try {
    const { notes, groups, trash } = req.body;
    if (!Array.isArray(notes)) return res.status(400).json({ error: 'invalid' });
    const data = { notes, groups: groups || [], trash: trash || [], updatedAt: Date.now() };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true, updatedAt: data.updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── MCP SSE ──────────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: 'list_notes',
    description: '获取备忘录笔记列表（只含标题和ID，不含全文）',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认20' }
      }
    }
  },
  {
    name: 'get_note',
    description: '根据ID获取某条笔记的完整内容',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'search_notes',
    description: '搜索笔记，返回包含关键词的笔记列表',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' }
      },
      required: ['query']
    }
  },
  {
    name: 'create_note',
    description: '新建一条笔记',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记标题（可选）' },
        content: { type: 'string', description: '笔记内容（支持Markdown）' }
      },
      required: ['content']
    }
  },
  {
    name: 'update_note',
    description: '更新某条笔记的内容',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记ID' },
        content: { type: 'string', description: '新的内容' },
        title: { type: 'string', description: '新的标题（可选）' }
      },
      required: ['id', 'content']
    }
  }
];

function handleTool(name, args) {
  const data = readData();
  const notes = data.notes || [];

  if (name === 'list_notes') {
    const limit = args.limit || 20;
    const list = notes.slice(0, limit).map(n => ({
      id: n.id,
      title: n.title || n.content?.split('\n')[0]?.slice(0, 30) || '无标题',
      updatedAt: new Date(n.updatedAt).toLocaleString('zh-CN')
    }));
    return { type: 'text', text: JSON.stringify(list, null, 2) };
  }

  if (name === 'get_note') {
    const note = notes.find(n => n.id === args.id);
    if (!note) return { type: 'text', text: '未找到该笔记' };
    return { type: 'text', text: `标题：${note.title || '无标题'}\n更新时间：${new Date(note.updatedAt).toLocaleString('zh-CN')}\n\n${note.content}` };
  }

  if (name === 'search_notes') {
    const q = args.query.toLowerCase();
    const results = notes.filter(n =>
      (n.title || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q)
    ).slice(0, 10).map(n => ({
      id: n.id,
      title: n.title || n.content?.split('\n')[0]?.slice(0, 30) || '无标题',
      preview: n.content?.slice(0, 100) + '...'
    }));
    return { type: 'text', text: results.length ? JSON.stringify(results, null, 2) : '没有找到相关笔记' };
  }

  if (name === 'create_note') {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const note = {
      id,
      title: args.title || '',
      content: args.content,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    data.notes = [note, ...notes];
    writeData(data);
    return { type: 'text', text: `✅ 笔记已创建，ID：${id}` };
  }

  if (name === 'update_note') {
    const idx = notes.findIndex(n => n.id === args.id);
    if (idx === -1) return { type: 'text', text: '未找到该笔记' };
    data.notes[idx].content = args.content;
    if (args.title !== undefined) data.notes[idx].title = args.title;
    data.notes[idx].updatedAt = Date.now();
    writeData(data);
    return { type: 'text', text: '✅ 笔记已更新' };
  }

  return { type: 'text', text: '未知工具' };
}

// SSE 连接管理
const sseClients = new Map();

app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now().toString();
  sseClients.set(clientId, res);

  // 发送初始化
  const initMsg = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  };
  res.write(`data: ${JSON.stringify(initMsg)}\n\n`);

  // 发送端点信息
  const endpointMsg = {
    jsonrpc: '2.0',
    method: 'endpoint',
    params: { uri: `/message?clientId=${clientId}` }
  };
  res.write(`event: endpoint\ndata: ${JSON.stringify(endpointMsg)}\n\n`);

  req.on('close', () => sseClients.delete(clientId));
});

app.post('/message', express.json(), (req, res) => {
  const clientId = req.query.clientId;
  const sseRes = sseClients.get(clientId);
  const msg = req.body;

  res.json({ ok: true });

  let response;

  if (msg.method === 'initialize') {
    response = {
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memo-mcp', version: '1.0.0' }
      }
    };
  } else if (msg.method === 'tools/list') {
    response = {
      jsonrpc: '2.0', id: msg.id,
      result: { tools: MCP_TOOLS }
    };
  } else if (msg.method === 'tools/call') {
    try {
      const result = handleTool(msg.params.name, msg.params.arguments || {});
      response = {
        jsonrpc: '2.0', id: msg.id,
        result: { content: [result] }
      };
    } catch (e) {
      response = {
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: '错误：' + e.message }], isError: true }
      };
    }
  } else {
    response = { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  if (sseRes) {
    sseRes.write(`data: ${JSON.stringify(response)}\n\n`);
  }
});

app.listen(PORT, () => console.log(`memo-server + MCP running on :${PORT}`));
