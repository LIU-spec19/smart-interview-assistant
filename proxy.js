/**
 * 虚拟面试官 · 本地代理服务器
 * 作用：转发火山引擎 TTS 请求，解决浏览器跨域问题
 *
 * 启动方式：
 *   node proxy.js
 *
 * 需要 Node.js 18+（自带 fetch）
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// 文件解析库（需要安装：npm install pdf-parse mammoth）
let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch(e) { console.warn('[Init] pdf-parse 未安装，PDF解析不可用'); }
try { mammoth = require('mammoth'); }  catch(e) { console.warn('[Init] mammoth 未安装，Word解析不可用'); }

const PORT = 8866;

// ===== 火山引擎 TTS 配置 =====
const VOLC_APP_ID  = process.env.VOLC_APP_ID || '';
const VOLC_TOKEN   = process.env.VOLC_TOKEN || '';
const VOLC_TTS_URL = 'https://openspeech.bytedance.com/api/v1/tts';

// ===== 阿里云百炼 Qwen-VL 配置（视觉分析用）=====
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// ===== 音色配置（HR性别 × 面试官类型）二维映射 =====
const VOICE_MAP = {
  male: {
    strict:       { voice_type: 'BV102_streaming', speed_ratio: 1.15, pitch_ratio: 0.88, volume_ratio: 1.0  },
    gentle:       { voice_type: 'BV113_streaming', speed_ratio: 0.95, pitch_ratio: 1.0,  volume_ratio: 1.0  },
    enthusiastic: { voice_type: 'BV056_streaming', speed_ratio: 1.1,  pitch_ratio: 1.05, volume_ratio: 1.05 },
  },
  female: {
    strict:       { voice_type: 'BV001_streaming', speed_ratio: 1.12, pitch_ratio: 0.95, volume_ratio: 1.0  },
    gentle:       { voice_type: 'BV001_streaming', speed_ratio: 0.92, pitch_ratio: 1.06, volume_ratio: 1.0  },
    enthusiastic: { voice_type: 'BV700_streaming', speed_ratio: 1.1,  pitch_ratio: 1.12, volume_ratio: 1.05 },
  },
};

// ===== 工具函数：转发 HTTPS 请求 =====
function httpsPost(targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const bodyBuf = Buffer.from(body, 'utf8');

    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'POST',
      headers:  { ...headers, 'Content-Length': bodyBuf.length },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ===== 主服务器 =====
const server = http.createServer(async (req, res) => {

  // 允许所有跨域请求（只供本地使用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);

  // ===== 路由：TTS 语音合成 =====
  if (req.method === 'POST' && parsedUrl.pathname === '/tts') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { text, interviewerType, hrGender } = JSON.parse(body);

        if (!text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'text 不能为空' }));
          return;
        }
        if (!VOLC_APP_ID || !VOLC_TOKEN) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'VOLC_APP_ID and VOLC_TOKEN are not configured' }));
          return;
        }

        // 根据 HR 性别 + 面试官类型 选音色，确保声音与姓名性别一致
        const gender   = hrGender === 'male' ? 'male' : 'female';
        const typeMap  = VOICE_MAP[gender];
        const voiceCfg = typeMap[interviewerType] || typeMap.gentle;
        console.log(`[TTS] 性别:${gender} 类型:${interviewerType} 音色:${voiceCfg.voice_type} 文字长度:${text.length}`);

        const payload = JSON.stringify({
          app: {
            appid:   VOLC_APP_ID,
            token:   VOLC_TOKEN,
            cluster: 'volcano_tts',
          },
          user: { uid: 'interview_user' },
          audio: {
            voice_type:   voiceCfg.voice_type,
            encoding:     'mp3',
            speed_ratio:  voiceCfg.speed_ratio,
            volume_ratio: voiceCfg.volume_ratio,
            pitch_ratio:  voiceCfg.pitch_ratio,
          },
          request: {
            reqid:     `req_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            text:      text.substring(0, 500),
            text_type: 'plain',
            operation: 'query',
          },
        });

        const result = await httpsPost(
          VOLC_TTS_URL,
          {
            'Content-Type':  'application/json',
            'Authorization': `Bearer;${VOLC_TOKEN}`,
          },
          payload
        );

        const volcData = JSON.parse(result.body);
        console.log(`[TTS] 火山引擎返回 code=${volcData.code} message=${volcData.message}`);

        if (volcData.code !== 3000 || !volcData.data) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `TTS失败: ${volcData.message}` }));
          return;
        }

        // 返回 base64 音频数据给前端
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ audio: volcData.data }));

      } catch (e) {
        console.error('[TTS] 出错：', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ===== 路由：文件解析（PDF / Word → 纯文本）=====
  if (req.method === 'POST' && parsedUrl.pathname === '/parse-file') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        // 请求体格式：JSON { fileName, fileData(base64), fileType }
        const { fileName, fileData, fileType } = JSON.parse(body.toString('utf8'));

        if (!fileData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少文件数据' }));
          return;
        }

        const buffer = Buffer.from(fileData, 'base64');
        let text = '';
        const ext = (fileName || '').toLowerCase().split('.').pop();

        console.log(`[Parse] 解析文件: ${fileName} (${ext}) 大小: ${(buffer.length/1024).toFixed(1)}KB`);

        if (ext === 'pdf') {
          if (!pdfParse) throw new Error('pdf-parse 未安装，请运行: npm install pdf-parse');
          const result = await pdfParse(buffer);
          text = result.text;
        } else if (ext === 'docx' || ext === 'doc') {
          if (!mammoth) throw new Error('mammoth 未安装，请运行: npm install mammoth');
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        } else {
          throw new Error(`不支持的文件格式：${ext}，仅支持 PDF、Word`);
        }

        // 清理文本：去除多余空行和空白
        text = text
          .replace(/\r\n|\r|\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .trim();

        if (!text || text.length < 20) {
          throw new Error('文件内容为空或无法识别，请检查文件是否为扫描件');
        }

        // 截取前4000字（避免token过多）
        const truncated = text.length > 4000;
        const excerpt   = text.substring(0, 4000);

        // 生成摘要（取前150字）
        const summary = text.substring(0, 150).replace(/\n/g, ' ') + (text.length > 150 ? '...' : '');

        console.log(`[Parse] 解析成功，字符数: ${text.length}${truncated ? '（已截取前4000字）' : ''}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text:      excerpt,
          summary,
          charCount: text.length,
          truncated,
          fileName,
          fileType,  // 'resume' | 'jd' | 'both-resume' | 'both-jd'
        }));

      } catch (e) {
        console.error('[Parse] 解析出错：', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ===== 路由：视觉分析（表情识别 + 置信度评分）=====
  if (req.method === 'POST' && parsedUrl.pathname === '/vision') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { image, round, apiKey, interviewType } = JSON.parse(body);

        if (!image) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少图片数据' }));
          return;
        }
        if (!QWEN_API_KEY) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'QWEN_API_KEY is not configured' }));
          return;
        }

        console.log(`[Vision] 第${round}题 面试类型:${interviewType} 开始分析...`);

        const promptText = `你是一位专业的面试评估师，正在通过摄像头画面分析面试者的非语言表现。

请分析图片中面试者的状态，以 JSON 格式返回以下字段（不要返回其他内容）：
{
  "score": 0-100的整数（综合置信度，100=极度自信放松，0=极度紧张焦虑），
  "emotion": 一个2-4字的词描述面部表情（如：自信微笑、面无表情、略显紧张、神情专注），
  "posture": 一个2-4字的词描述坐姿状态（如：姿态端正、稍显放松、略有驼背、身体前倾），
  "energy": 一个2-4字的词描述整体状态（如：状态充沛、略显疲态、精神专注、有些散漫），
  "tip": 一句15字以内的改进建议，语气鼓励（如：保持微笑会让你更有感染力）
}

评分参考：
- 75-100：表情自然、眼神有神、姿态端正、状态积极
- 50-74：基本正常但有轻微紧张迹象
- 25-49：明显紧张、回避视线或姿态不佳
- 0-24：高度紧张或明显分心

只返回 JSON，不要有任何其他文字。`;

        // 调用阿里云百炼 Qwen-VL 视觉模型分析表情和姿态
        // 文档：https://help.aliyun.com/zh/model-studio/developer-reference/qwen-vl-api
        const qwenPayload = JSON.stringify({
          model: 'qwen-vl-max',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${image}` }
              },
              { type: 'text', text: promptText }
            ]
          }]
        });

        const qwenResult = await httpsPost(
          QWEN_API_URL,
          {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${QWEN_API_KEY}`,
          },
          qwenPayload
        );

        const qwenData = JSON.parse(qwenResult.body);
        console.log(`[Vision] Qwen-VL 返回状态: ${qwenResult.status}`);

        if (qwenData.error) {
          throw new Error(qwenData.error.message || JSON.stringify(qwenData.error));
        }
        if (!qwenData.choices || !qwenData.choices[0]) {
          throw new Error('Qwen-VL 无返回内容: ' + JSON.stringify(qwenData));
        }

        // 解析 JSON 响应（OpenAI 兼容格式）
        const rawText = qwenData.choices[0].message.content.trim();
        let analysisResult;
        try {
          // 提取 JSON（防止有多余文字）
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          analysisResult = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
        } catch (parseErr) {
          console.warn('[Vision] JSON解析失败，使用默认值', rawText);
          analysisResult = { score: 60, emotion: '表情自然', posture: '姿态正常', energy: '状态一般', tip: '保持自信，展现最好的自己' };
        }

        console.log(`[Vision] 分析完成 score=${analysisResult.score} emotion=${analysisResult.emotion}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(analysisResult));

      } catch (e) {
        console.error('[Vision] 出错：', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ===== 路由：Python AI 后端服务转发 =====
  // 将 /rag/* /vector/* /resume/* /log/* /stats 转发到 Python FastAPI (port 8001)
  const pythonPrefixes = ['/rag/', '/vector/', '/resume/', '/log/', '/stats'];
  const isPythonRoute = pythonPrefixes.some(prefix => parsedUrl.pathname.startsWith(prefix));

  if (isPythonRoute) {
    try {
      const pythonUrl = `http://localhost:8001${parsedUrl.pathname}${parsedUrl.search || ''}`;
      const options = url.parse(pythonUrl);
      options.method = req.method;
      options.headers = {
        'Content-Type': req.headers['content-type'] || 'application/json',
      };

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('[Proxy→Python] 转发失败:', err.message);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          message: 'AI后端服务未启动，请先运行: cd backend && python main.py',
          detail: err.message,
        }));
      });

      req.pipe(proxyReq);
      return;
    } catch (e) {
      console.error('[Proxy→Python] 异常:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // ===== 路由：健康检查 =====
  if (req.method === 'GET' && parsedUrl.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: '代理服务器运行正常 ✅' }));
    return;
  }

  // ===== 静态文件服务（直接访问 http://localhost:8866 打开面试官页面）=====
  if (req.method === 'GET') {
    let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
    filePath = path.join(__dirname, filePath);

    const extMap = {
      '.html': 'text/html; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
    };

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': extMap[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ===== 首次启动自动安装依赖 =====
const { execSync } = require('child_process');
function autoInstall() {
  const needed = [];
  try { require('pdf-parse'); } catch(e) { needed.push('pdf-parse'); }
  try { require('mammoth');   } catch(e) { needed.push('mammoth');   }

  if (needed.length > 0) {
    console.log(`[Init] 正在安装依赖：${needed.join(', ')} ...`);
    try {
      execSync(`npm install ${needed.join(' ')}`, { stdio: 'inherit', cwd: __dirname });
      console.log('[Init] 依赖安装完成，重新加载...');
      // 重新 require
      if (needed.includes('pdf-parse')) pdfParse = require('pdf-parse');
      if (needed.includes('mammoth'))   mammoth   = require('mammoth');
    } catch(e) {
      console.warn('[Init] 自动安装失败，请手动运行: npm install pdf-parse mammoth');
    }
  }
}
autoInstall();

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   虚拟面试官 · 本地代理服务器已启动      ║');
  console.log(`║   访问地址：http://localhost:${PORT}       ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log('📌 请用浏览器打开：http://localhost:8866');
  console.log('📌 不要直接双击打开 index.html，否则跨域问题依然存在');
  console.log('');
  console.log('⚠️  如需使用 RAG / 向量检索 / 日志分析 功能，');
  console.log('    请同时启动 Python AI 后端：');
  console.log('    cd backend && pip install -r requirements.txt && python main.py');
  console.log('');
  console.log('按 Ctrl+C 停止服务器');
  console.log('');
});
