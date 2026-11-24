/* =====================================================
   虚拟面试官 · script.js
   ===================================================== */

// ===== 全局状态 =====
const state = {
  job: '',
  type: '',
  model: 'api',          // 'api' -> DeepSeek API | 'local' -> 本地LoRA模型
  gender: 'male',        // 候选人演示头像
  round: 0,
  maxRounds: 6,
  messages: [],          // 对话历史 [{role, content}]
  speaking: false,       // 是否正在等待 API 响应
  recording: false,      // 是否正在语音录音
  stream: null,          // 摄像头 MediaStream
  hrName: '',
  hrGender: 'female',
  synth: window.speechSynthesis,
  systemPrompt: '',
  currentAudio: null,    // 当前播放的 Audio 对象
  sessionId: null,       // 面试会话ID（用于日志上报）
  roundStartTime: 0,     // 本轮开始时间戳
  lastQuestion: '',      // 上一轮HR的问题（用于日志）
};

// ===== 火山引擎 TTS 音色配置 =====
// 按「HR性别 × 面试官类型」二维映射，确保音色与姓名性别一致
// 完整音色列表：https://www.volcengine.com/docs/6561/97465
const VOLC_VOICE_MAP = {
  male: {
    // ⚡ 严厉型男：低沉磁性，语速快，有压迫感
    strict: {
      voice_type: 'BV102_streaming',  // 磁性男声
      speed_ratio: 1.15,
      volume_ratio: 1.0,
      pitch_ratio: 0.88,              // 更低沉，威严感强
    },
    // 🌿 和蔼型男：沉稳温和，语速适中
    gentle: {
      voice_type: 'BV113_streaming',  // 温和男声
      speed_ratio: 0.95,
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
    },
    // 🔥 热情型男：明朗爽快，语速较快
    enthusiastic: {
      voice_type: 'BV056_streaming',  // 活力男声
      speed_ratio: 1.1,
      volume_ratio: 1.05,
      pitch_ratio: 1.05,
    },
  },
  female: {
    // ⚡ 严厉型女：干练清晰，语速快，不失女性气质
    strict: {
      voice_type: 'BV001_streaming',  // 通用女声（偏专业）
      speed_ratio: 1.12,
      volume_ratio: 1.0,
      pitch_ratio: 0.95,              // 音调稍低，显专业
    },
    // 🌿 和蔼型女：温柔亲切，语速慢，音调自然
    gentle: {
      voice_type: 'BV001_streaming',  // 通用女声
      speed_ratio: 0.92,
      volume_ratio: 1.0,
      pitch_ratio: 1.06,
    },
    // 🔥 热情型女：活泼元气，语速快，音调明亮
    enthusiastic: {
      voice_type: 'BV700_streaming',  // 活力女声
      speed_ratio: 1.1,
      volume_ratio: 1.05,
      pitch_ratio: 1.12,
    },
  },
};

// 根据 HR 性别 + 面试官类型 获取音色配置
function getVoiceConfig() {
  const genderMap = VOLC_VOICE_MAP[state.hrGender] || VOLC_VOICE_MAP.female;
  return genderMap[state.type] || genderMap.gentle;
}

// ===== 数据映射 =====
const JOB_MAP = {
  software:  { label: '软件工程师',       emoji: '💻' },
  product:   { label: '产品经理',         emoji: '📱' },
  design:    { label: 'UI/UX 设计师',     emoji: '🎨' },
  marketing: { label: '市场营销',         emoji: '📊' },
  data:      { label: '数据分析师',       emoji: '📈' },
  custom:    { label: '自定义（资料驱动）', emoji: '📄' },
};

const TYPE_MAP = {
  strict:       { label: '严厉型', emoji: '⚡', class: 'type-strict',       color: '#e05060' },
  gentle:       { label: '和蔼型', emoji: '🌿', class: 'type-gentle',       color: '#0eb07a' },
  enthusiastic: { label: '热情型', emoji: '🔥', class: 'type-enthusiastic', color: '#e69b00' },
};

const HR_NAMES = {
  male:   ['王强', '李刚', '张明', '陈浩'],
  female: ['李娜', '王芳', '张丽', '刘静'],
};

const TIPS = [
  '深呼吸，保持镇定。你的准备是有价值的！',
  '用 STAR 法则：情境、任务、行动、结果，清晰表达经历。',
  '展示你的思维过程，面试官更在乎思路而非完美答案。',
  '可以说「请让我思考一下」，从容是自信的体现。',
  '你已经做好准备了，相信自己，展现真实的你！',
  '保持自然的眼神交流，语速适中，展现最好的一面。',
];

// ===== SVG 虚拟形象 =====
function hrMaleAvatar(c = '#3a68f0') {
  return `<svg viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
    <circle cx="28" cy="28" r="28" fill="#eef2ff"/>
    <circle cx="28" cy="21" r="10" fill="${c}"/>
    <rect x="12" y="38" width="32" height="16" rx="8" fill="${c}"/>
    <rect x="19" y="27" width="18" height="8" rx="3" fill="${c}99"/>
    <rect x="22" y="13" width="12" height="3.5" rx="1.5" fill="${c}66"/>
    <circle cx="24" cy="21" r="2" fill="rgba(255,255,255,0.5)"/>
    <circle cx="32" cy="21" r="2" fill="rgba(255,255,255,0.5)"/>
  </svg>`;
}

function hrFemaleAvatar(c = '#7c55f5') {
  return `<svg viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
    <circle cx="28" cy="28" r="28" fill="#f3f0ff"/>
    <circle cx="28" cy="21" r="10" fill="${c}"/>
    <rect x="12" y="38" width="32" height="16" rx="8" fill="${c}"/>
    <ellipse cx="28" cy="13" rx="11" ry="5" fill="${c}80"/>
    <rect x="19" y="27" width="18" height="8" rx="3" fill="${c}90"/>
    <circle cx="24" cy="21" r="2" fill="rgba(255,255,255,0.5)"/>
    <circle cx="32" cy="21" r="2" fill="rgba(255,255,255,0.5)"/>
  </svg>`;
}

function candidateMaleAvatar(c = '#0eb07a') {
  return `<svg viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
    <circle cx="28" cy="28" r="28" fill="#ecfdf5"/>
    <circle cx="28" cy="21" r="10" fill="${c}"/>
    <rect x="13" y="38" width="30" height="16" rx="8" fill="${c}"/>
    <rect x="19" y="27" width="18" height="7" rx="2.5" fill="${c}70"/>
    <rect x="23" y="13" width="10" height="3" rx="1.5" fill="${c}55"/>
    <circle cx="24" cy="21" r="2" fill="rgba(255,255,255,0.45)"/>
    <circle cx="32" cy="21" r="2" fill="rgba(255,255,255,0.45)"/>
  </svg>`;
}

function candidateFemaleAvatar(c = '#0eb07a') {
  return `<svg viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
    <circle cx="28" cy="28" r="28" fill="#ecfdf5"/>
    <circle cx="28" cy="21" r="10" fill="${c}"/>
    <rect x="13" y="38" width="30" height="16" rx="8" fill="${c}"/>
    <ellipse cx="28" cy="13" rx="10" ry="4.5" fill="${c}75"/>
    <rect x="19" y="27" width="18" height="7" rx="2.5" fill="${c}70"/>
    <circle cx="24" cy="21" r="2" fill="rgba(255,255,255,0.45)"/>
    <circle cx="32" cy="21" r="2" fill="rgba(255,255,255,0.45)"/>
  </svg>`;
}

// ===== 配置页：选项与校验 =====
function selectOption(group, btn) {
  btn.closest('.option-grid').querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  state[group] = btn.dataset.value;

  // 本地模型选择时显示提示
  if (group === 'model') {
    const hint = document.getElementById('model-hint');
    if (hint) hint.style.display = state.model === 'local' ? 'block' : 'none';
  }

  checkReady();
}

function checkReady() {
  // 需选择职位、面试官类型和模型
  document.getElementById('start-btn').disabled = !(state.job && state.type && state.model);
}

// ===== 摄像头与性别识别 =====
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const preview = document.getElementById('camera-preview');
    preview.srcObject = state.stream;
    preview.style.display = 'block';
    document.getElementById('gender-result').style.display = 'flex';
    detectGender();
  } catch (e) {
    alert('无法访问摄像头：' + e.message);
  }
}

async function detectGender() {
  // 头像演示使用随机分配；摄像头画面不用于推断性别。
  state.gender = Math.random() > 0.5 ? 'male' : 'female';
  updateGenderBadge();
}

function updateGenderBadge() {
  document.getElementById('gender-badge').textContent =
    state.gender === 'female' ? '👩 女性演示形象（随机）' : '👨 男性演示形象（随机）';
}

// ===== 开始面试 =====
function startInterview() {
  if (!state.job || !state.type || !state.model) return;

  // 随机分配 HR
  state.hrGender = Math.random() > 0.5 ? 'male' : 'female';
  const names = HR_NAMES[state.hrGender];
  state.hrName = names[Math.floor(Math.random() * names.length)];

  // 切换页面
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('interview-screen').style.display = 'block';

  // 更新 UI 信息
  const ji = JOB_MAP[state.job];
  const ti = TYPE_MAP[state.type];
  const modelLabel = state.model === 'local' ? '🏠本地模型' : '☁️DeepSeek';
  const fileTag = (uploadedFiles.resume || uploadedFiles.jd)
    ? ` · 📄${uploadedFiles.resume && uploadedFiles.jd ? '简历+JD' : uploadedFiles.resume ? '简历专项' : 'JD专项'}`
    : '';
  document.getElementById('header-sub').textContent = `${ji.label} · ${ti.label}面试官 · ${modelLabel}${fileTag}`;
  document.getElementById('hr-name').textContent = state.hrName;

  const badge = document.getElementById('hr-type-badge');
  badge.className = 'char-type-badge ' + ti.class;
  badge.innerHTML = `${ti.emoji} ${ti.label}`;

  // 设置头像
  document.getElementById('hr-avatar').innerHTML =
    `<div class="speaking-ring" id="hr-ring"></div>` +
    (state.hrGender === 'female' ? hrFemaleAvatar(ti.color) : hrMaleAvatar(ti.color));

  document.getElementById('user-avatar').innerHTML =
    `<div class="speaking-ring" id="user-ring"></div>` +
    (state.gender === 'female' ? candidateFemaleAvatar() : candidateMaleAvatar());

  document.getElementById('user-name').textContent = state.gender === 'female' ? '应聘者（女）' : '应聘者（男）';
  document.getElementById('user-role-label').textContent = `应聘 ${ji.label}`;

  // 连接摄像头到面试页小窗
  if (state.stream) {
    const small = document.getElementById('webcam-small');
    small.srcObject = state.stream;
    small.style.display = 'block';
    document.getElementById('cam-status-mini').textContent =
      state.gender === 'female' ? '👩 女性应聘者' : '👨 男性应聘者';
  }

  rotateTips();
  buildSystemPrompt();
  setTimeout(() => {
    sendHRMessage();
    startVisionAnalysis();  // 启动视觉分析
  }, 800);
}

// 面试技巧轮换
function rotateTips() {
  let idx = 0;
  const el = document.getElementById('tip-text');
  el.textContent = TIPS[0];
  el.style.transition = 'opacity 0.3s';
  setInterval(() => {
    idx = (idx + 1) % TIPS.length;
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = TIPS[idx]; el.style.opacity = '1'; }, 300);
  }, 9000);
}

// 构建系统提示词
function buildSystemPrompt() {
  const ji = JOB_MAP[state.job];
  const typeDesc = {
    strict: `你叫${state.hrName}，是个做事利落、不废话的面试官。你说话直接，对模糊的回答会毫不客气地追问"这个你能说具体点吗"或"听起来有点虚，实际怎么做的"。你不会安慰候选人，也不会刻意刁难，但你对水平高低判断很准，一眼就能看出谁是真有料谁是在背答案。`,
    gentle: `你叫${state.hrName}，是个说话温和、听起来很好聊的面试官。你会认真听完对方说的每一句话，偶尔点头回应，碰到候选人卡住了会说"不用急，你可以想想"。你的问题不会很刁，但你希望候选人能真实表达自己，而不是背标准答案。`,
    enthusiastic: `你叫${state.hrName}，是个特别有劲头的面试官，说话带感染力。你会对有意思的回答说"哦这个挺好的，那你当时是怎么想的？"，也会把气氛搞得轻松点。你问问题不走寻常路，有时候会从候选人说的某句话里接着聊。`,
  }[state.type];

  const scoringRules = {
    strict: {
      desc: '你评分极其严格，宁可打低分也不随意给高分。',
      baseline: '答案模糊或不专业：30-45分。有基础但不深入：46-60分。答得较好但有明显缺失：61-74分。全面深入有亮点：75-88分。极其出色：89-100分。',
      penalty: '敷衍回答（如"不知道""随便"）直接扣到25分以下。答非所问扣到35分以下。',
    },
    gentle: {
      desc: '你评分相对温和，但仍然客观公正，不因为鼓励就虚报高分。',
      baseline: '几乎没有实质内容：35-50分。有一定想法但不完整：51-65分。回答合格有自己思考：66-78分。表现良好有深度：79-90分。非常优秀：91-100分。',
      penalty: '完全无关或乱答扣到30分以下。明显敷衍扣到40分以下。',
    },
    enthusiastic: {
      desc: '你评分积极，但诚实负责，不会对明显差的回答打高分。',
      baseline: '基本没有回答出来：40-52分。有基本思路不够深：53-67分。回答到位有条理：68-80分。表现优秀有亮点：81-92分。完美发挥：93-100分。',
      penalty: '答非所问或乱说扣到35分以下。完全沉默或"不会"扣到38分以下。',
    },
  }[state.type];

  const fileContext = buildFileContext();  // 注入简历/JD上下文（可能为空）

  state.systemPrompt = `你是${state.hrName}，${ji.label}职位的HR面试官。${typeDesc}

【评分规则 — 必须严格遵守】
${scoringRules.desc}
评分档位参考：${scoringRules.baseline}
惩罚规则：${scoringRules.penalty}
- 评分必须基于候选人每一轮回答的实际质量综合评估，不能因为面试官风格温和就随意给高分
- 全程回答质量差但一两题答得还行，最终不得超过55分
- 禁止给出"安慰分"，评分必须真实反映候选人水平
- 综合评分 = 各题回答质量加权平均，不受候选人态度好坏影响（态度好不加分，但礼貌得体可适当+3分上限）

对话要求（最重要）：
- 说话像真人，不像机器。用口语，不用书面列举，不说"首先…其次…最后…"
- 每次回复控制在3-5句话以内，不要长篇大论
- 点评上一个回答时，1句话即可，直接切入，不要过度铺垫
- 提问要自然，像聊天一样抛出来，不要加序号或"请问"
- 追问时可以说"你刚才说的X，能展开讲讲吗？"而不是重新问一个新问题
- 绝对不要在回复里出现"作为面试官"、"根据资料"、"简历显示"这类机器人语气

面试流程（严格遵守）：
- 共${state.maxRounds}轮，每轮一个问题
- 第1轮到第${state.maxRounds-1}轮：简短点评（1-2句）+ 提出下一题
- 第${state.maxRounds}轮（最后一轮）：1句话点评 + 直接给出面试总结和评分，绝对不要再问新问题
- 总结必须简洁，格式：「面试总结：一句话评价。综合评分：XX分。建议：一句话建议。」
- 评分标准不因风格改变，消息里会注明当前轮次

请用中文回复。${fileContext}`;
}

// ===== 聊天消息渲染 =====
function addMessage(role, content) {
  const container = document.getElementById('chat-messages');
  const isHR = role === 'hr';
  const hrSvg = state.hrGender === 'female'
    ? hrFemaleAvatar(TYPE_MAP[state.type].color)
    : hrMaleAvatar(TYPE_MAP[state.type].color);
  const uSvg = state.gender === 'female' ? candidateFemaleAvatar() : candidateMaleAvatar();

  const div = document.createElement('div');
  div.className = `msg ${isHR ? 'hr-msg' : 'user-msg'}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  div.innerHTML = `
    <div class="msg-avatar">${isHR ? hrSvg : uSvg}</div>
    <div>
      <div class="msg-bubble">${content}</div>
      <div class="msg-meta">${isHR ? state.hrName : '你'} · ${time}</div>
    </div>
  `;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showThinking() {
  const container = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg hr-msg';
  wrap.id = 'thinking-wrap';
  const hrSvg = state.hrGender === 'female'
    ? hrFemaleAvatar(TYPE_MAP[state.type].color)
    : hrMaleAvatar(TYPE_MAP[state.type].color);
  wrap.innerHTML = `
    <div class="msg-avatar">${hrSvg}</div>
    <div class="thinking-dots"><span></span><span></span><span></span></div>
  `;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

function hideThinking() {
  const el = document.getElementById('thinking-wrap');
  if (el) el.remove();
}

// ===== RAG + DeepSeek API 调用 =====
// 优先调用本地RAG服务，不可用时降级到直接调用DeepSeek API

async function callRAG(userMessage) {
  // 调用RAG服务：向量检索 + LLM生成
  try {
    const res = await fetch('http://localhost:8866/rag/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: userMessage,
        category: state.job,
        use_resume: !!uploadedFiles.resume,
        resume_id: 'user_resume',
        top_k: 3,
        model_type: state.model,  // 'api' 或 'local'
      }),
    });

    if (!res.ok) throw new Error(`RAG服务错误 ${res.status}`);
    const data = await res.json();

    if (data.status !== 'success') throw new Error(data.message || 'RAG返回异常');

    console.log(`[RAG] 检索到 ${data.retrieved_sources?.length || 0} 条相关题目 | 模型: ${data.model_used}`);
    return {
      answer: data.answer,
      sources: data.retrieved_sources || [],
      model: data.model_used || 'rag',
      rag_used: true,
    };
  } catch (e) {
    console.warn('[RAG] 调用失败，降级到直接API:', e.message);
    return null;
  }
}

async function vectorizeResume(text) {
  // 将简历文本发送到后端进行向量化
  try {
    const res = await fetch('http://localhost:8866/resume/vectorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resume_text: text,
        resume_id: 'user_resume',
        chunk_size: 500,
        overlap: 100,
      }),
    });
    if (!res.ok) throw new Error(`向量化失败 ${res.status}`);
    const data = await res.json();
    console.log(`[Vectorize] 简历向量化完成: ${data.chunks || 0} 个分块`);
    return true;
  } catch (e) {
    console.warn('[Vectorize] 简历向量化失败:', e.message);
    return false;
  }
}

async function logInterviewRound(question, answer, score, duration) {
  // 上报面试问答日志到后端
  try {
    const sessionId = state.sessionId || `session_${Date.now()}`;
    state.sessionId = sessionId;
    await fetch('http://localhost:8866/log/interview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        round_num: state.round,
        question: question,
        user_answer: answer || '',
        score: score,
        duration_sec: duration,
        job_category: state.job,
        interview_type: state.type,
      }),
    });
  } catch (e) {
    // 日志上报失败不影响主流程
    console.warn('[Log] 日志上报失败:', e.message);
  }
}

async function callClaude(userMessage) {
  state.messages.push({ role: 'user', content: userMessage });
  showThinking();
  setHRSpeaking(false);

  // 优先尝试RAG
  const ragResult = await callRAG(userMessage);
  if (ragResult) {
    const reply = ragResult.answer;
    state.messages.push({ role: 'assistant', content: reply });
    hideThinking();
    // 在UI上标注使用了RAG
    setTimeout(() => showRAGIndicator(ragResult.sources), 100);
    return reply;
  }

  hideThinking();
  const reply = 'AI 面试服务暂时不可用，请检查 FastAPI 后端和服务端模型配置。';
  state.messages.push({ role: 'assistant', content: reply });
  return reply;
}

// 在对话气泡旁显示RAG检索来源指示器
function showRAGIndicator(sources) {
  if (!sources || sources.length === 0) return;
  const container = document.getElementById('chat-messages');
  const lastMsg = container.querySelector('.hr-msg:last-child');
  if (!lastMsg) return;

  const indicator = document.createElement('div');
  indicator.className = 'rag-indicator';
  indicator.style.cssText = 'font-size:0.68rem;color:var(--accent3);margin-top:4px;padding:2px 8px;background:rgba(58,104,240,0.06);border-radius:6px;display:inline-flex;gap:4px;align-items:center;';

  let html = '🔍 基于招聘大数据回答 · 参考 ';
  html += sources.map(s => `「${s.question.substring(0, 20)}...」`).join('、');
  indicator.innerHTML = html;

  const bubbleWrap = lastMsg.querySelector('div:nth-child(2)');
  if (bubbleWrap) bubbleWrap.appendChild(indicator);
}

// ===== 面试流程控制 =====
async function sendHRMessage(userReply = null) {
  // 如果有用户回答，先上报上一轮的日志
  if (userReply && state.lastQuestion) {
    const duration = Math.round((Date.now() - state.roundStartTime) / 1000);
    // 尝试从回复中提取分数
    const scoreMatch = state.messages[state.messages.length - 1]?.content?.match(/(\d+)\s*分/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : null;
    logInterviewRound(state.lastQuestion, userReply, score, duration);
  }

  state.round++;
  updateRoundBadge();
  state.roundStartTime = Date.now();

  let prompt;
  if (state.round === 1) {
    prompt = `开始面试。这是第1/${state.maxRounds}题，请做自我介绍式开场并提第一个专业问题。`;
  } else if (state.round === state.maxRounds) {
    // 最后一题：只点评+总结，绝对不要再问新问题
    prompt = `这是最后一题（第${state.round}/${state.maxRounds}题），候选人上一轮回答：「${userReply}」。请先给1句话简短点评，然后直接给出面试总结和综合评分。注意：这是面试的最后一题，绝对不要再提出新的问题。总结必须简洁，格式：「面试总结：一句话评价。综合评分：XX分。建议：一句话建议。」`;
  } else if (state.round > state.maxRounds) {
    // 如果意外进入第7轮，强制结束
    prompt = `面试已正式结束。请输出固定格式的总结：「面试总结：一句话评价。综合评分：XX分。建议：一句话建议。」`;
  } else {
    prompt = `这是第${state.round}/${state.maxRounds}题，候选人回答：「${userReply}」。请简短点评（1-2句话）然后提出下一个问题。`;
  }

  const reply = await callClaude(prompt);
  addMessage('hr', reply);

  // 记录本轮HR的问题（用于下一轮日志上报）
  // 从reply中提取问题部分（第一行或第一个问句）
  const firstLine = reply.split('\n')[0];
  const questionMatch = firstLine.match(/[^。？！]*[？?]/);
  state.lastQuestion = questionMatch ? questionMatch[0] : firstLine.substring(0, 100);

  // 更新侧边栏语音气泡
  const sp = document.getElementById('hr-speech');
  sp.textContent = reply.substring(0, 80) + (reply.length > 80 ? '...' : '');
  sp.classList.add('active');

  setHRSpeaking(true);

  // TTS 朗读，读完后检查是否结束
  speak(reply, () => {
    setHRSpeaking(false);
    if (reply.includes('面试总结') || reply.includes('综合评分') || state.round > state.maxRounds) {
      setTimeout(() => showResult(reply), 1500);
    }
  });

  // 更新进度条
  document.getElementById('interview-progress').style.width =
    Math.min((state.round / state.maxRounds) * 100, 100) + '%';
}

// 角色发言状态
function setHRSpeaking(on) {
  document.getElementById('hr-card').classList.toggle('active', on);
  const ring = document.getElementById('hr-ring');
  if (ring) ring.classList.toggle('active', on);
}

function setUserSpeaking(on) {
  document.getElementById('user-card').classList.toggle('active', on);
  const ring = document.getElementById('user-ring');
  if (ring) ring.classList.toggle('active', on);
}

// ===== TTS（文字转语音）=====
// 优先使用火山引擎 AI 语音，无 Token 时降级到浏览器自带 TTS

async function speak(text, onEnd) {
  // 停止当前正在播放的语音
  stopCurrentAudio();
  // 火山引擎 TTS 已配置，直接使用 AI 语音
  await speakVolc(text, onEnd);
}

// 停止当前音频
function stopCurrentAudio() {
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
  if (state.synth) state.synth.cancel();
}

// 火山引擎 TTS 调用（通过后端代理转发，解决跨域问题）
async function speakVolc(text, onEnd) {
  setVoiceStatus(`${state.hrName} 正在说话...`, 'speaking');

  try {
    // 请求后端 TTS 代理（Docker 部署时已内置）
    const res = await fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:            text,
        interviewerType: state.type,
        hrGender:        state.hrGender, // 传 HR 性别，代理据此选正确音色
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `代理服务器错误 ${res.status}`);
    }

    const data = await res.json();

    if (!data.audio) {
      throw new Error('代理未返回音频数据');
    }

    // base64 → Blob URL → Audio 播放
    const byteChars = atob(data.audio);
    const byteArr   = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    const blob     = new Blob([byteArr], { type: 'audio/mp3' });
    const audioUrl = URL.createObjectURL(blob);

    const audio = new Audio(audioUrl);
    state.currentAudio = audio;

    audio.onended = () => {
      state.currentAudio = null;
      URL.revokeObjectURL(audioUrl);
      setVoiceStatus('请回答上方问题（语音或文字）', '');
      onEnd && onEnd();
    };

    audio.onerror = () => {
      state.currentAudio = null;
      URL.revokeObjectURL(audioUrl);
      console.warn('音频播放失败，降级到浏览器TTS');
      speakBrowser(text, onEnd);
    };

    await audio.play();

  } catch (e) {
    // 代理未启动或请求失败，降级到浏览器TTS并给出提示
    console.warn('火山引擎TTS失败（代理未启动？）：', e.message);
    setVoiceStatus(`${state.hrName} 正在说话... ⚠️ 请启动 proxy.js`, 'speaking');
    speakBrowser(text, onEnd);
  }
}

// 浏览器自带 TTS（降级方案）
function speakBrowser(text, onEnd) {
  if (!state.synth) { onEnd && onEnd(); return; }
  state.synth.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'zh-CN';

  // 根据面试官类型调整语速语调
  const rateMap  = { strict: 1.15, gentle: 0.95, enthusiastic: 1.1 };
  const pitchMap = { strict: 0.85, gentle: 1.1,  enthusiastic: 1.2 };
  utter.rate  = rateMap[state.type]  || 1.0;
  utter.pitch = pitchMap[state.type] || 1.0;

  const voices = state.synth.getVoices();
  const zhVoice = voices.find(v => v.lang.includes('zh') || v.lang.includes('cmn'));
  if (zhVoice) utter.voice = zhVoice;

  utter.onend = () => {
    setVoiceStatus('请回答上方问题（语音或文字）', '');
    onEnd && onEnd();
  };

  setVoiceStatus(`${state.hrName} 正在说话... (浏览器TTS)`, 'speaking');
  state.synth.speak(utter);
}

// 语音状态提示
function setVoiceStatus(text, cls) {
  const el = document.getElementById('voice-status');
  el.textContent = text;
  el.className = 'voice-status' + (cls ? ' ' + cls : '');
}

// ===== STT（语音识别）=====
let recognition = null;

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const r = new SR();
  r.lang = 'zh-CN';
  r.continuous = false;
  r.interimResults = true;

  r.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    const inp = document.getElementById('text-input');
    inp.value = transcript;
    autoResize(inp);
  };

  r.onend = () => {
    if (state.recording) {
      state.recording = false;
      updateVoiceBtn();
      const text = document.getElementById('text-input').value.trim();
      if (text) {
        setVoiceStatus('语音识别完成，正在发送...', '');
        setTimeout(() => sendMessage(), 500);
      } else {
        setVoiceStatus('未识别到语音，请重试', '');
      }
    }
  };

  r.onerror = () => {
    state.recording = false;
    updateVoiceBtn();
    setVoiceStatus('语音识别失败，请使用文字输入', '');
  };

  return r;
}

function toggleRecording() {
  if (state.speaking) return;
  if (!recognition) recognition = initRecognition();
  if (!recognition) {
    setVoiceStatus('此浏览器不支持语音识别，请使用文字输入', '');
    return;
  }

  if (state.recording) {
    recognition.stop();
    state.recording = false;
    updateVoiceBtn();
  } else {
    state.synth && state.synth.cancel();
    recognition.start();
    state.recording = true;
    updateVoiceBtn();
    setVoiceStatus('🔴 正在录音... 点击停止', 'recording');
    setUserSpeaking(true);
  }
}

function updateVoiceBtn() {
  const btn = document.getElementById('voice-btn');
  if (state.recording) {
    btn.className = 'voice-btn recording';
    btn.textContent = '⏹';
  } else {
    btn.className = 'voice-btn';
    btn.textContent = '🎤';
    setUserSpeaking(false);
  }
}

// ===== 发送消息 =====
async function sendMessage() {
  const inp = document.getElementById('text-input');
  const text = inp.value.trim();
  if (!text || state.speaking) return;

  inp.value = '';
  autoResize(inp);

  addMessage('user', text);

  const sp = document.getElementById('user-speech');
  sp.textContent = text.substring(0, 60) + (text.length > 60 ? '...' : '');
  sp.classList.add('active');

  setVoiceStatus('HR 正在思考...', '');
  setUserSpeaking(false);

  state.speaking = true;
  document.getElementById('send-btn').disabled = true;

  await sendHRMessage(text);

  state.speaking = false;
  document.getElementById('send-btn').disabled = false;
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function updateRoundBadge() {
  document.getElementById('round-badge').textContent =
    `第 ${Math.min(state.round, state.maxRounds)} / ${state.maxRounds} 题`;
}

// ===== 结果页 =====
function showResult(summary) {
  document.getElementById('interview-screen').style.display = 'none';
  const resultEl = document.getElementById('result-screen');
  resultEl.style.display = 'flex';

  // 提取分数
  const match = summary.match(/(\d+)\s*分/);
  const score = match ? parseInt(match[1]) : 75;
  document.getElementById('result-score').textContent = score;

  // 根据分数设置颜色
  const scoreEl = document.getElementById('result-score');
  if (score >= 85) {
    scoreEl.style.background = 'linear-gradient(135deg, #0eb07a, #3a68f0)';
  } else if (score >= 65) {
    scoreEl.style.background = 'linear-gradient(135deg, #3a68f0, #7c55f5)';
  } else {
    scoreEl.style.background = 'linear-gradient(135deg, #e69b00, #d93a3a)';
  }
  scoreEl.style.webkitBackgroundClip = 'text';
  scoreEl.style.webkitTextFillColor = 'transparent';

  document.getElementById('result-summary').textContent = summary;

  // 渲染非语言表现报告
  stopVisionAnalysis();
  renderVisualReport();
}

function endInterview() {
  if (!confirm('确定要结束本次面试吗？')) return;
  state.synth && state.synth.cancel();
  try { if (recognition) recognition.stop(); } catch (e) {}
  stopVisionAnalysis();
  showResult(
    `面试已提前结束，共完成 ${Math.max(state.round - 1, 0)} 题。` +
    `面试总结：候选人展现了一定的专业素养，但面试未完整进行。` +
    `综合评分：60分。建议：坚持完整面试，充分展示自己的实力，你一定可以的！`
  );
}

// ===== 初始化 =====
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {};
  window.speechSynthesis.getVoices();
}

// =====================================================
//   视觉分析模块（表情识别 + 实时置信度评分）
//   每 25 秒截一帧摄像头画面，发给 Claude Vision 分析
// =====================================================

const vision = {
  aiTimer:      null,    // AI分析定时器（每8秒调用一次API）
  localTimer:   null,    // 本地实时检测定时器（每1秒一次，无需API）
  interval:     8000,    // AI分析间隔：8秒
  localInterval: 1000,   // 本地检测间隔：1秒
  snapshots:    [],      // AI分析结果快照列表
  avgScore:     0,       // 平均置信度
  analyzing:    false,   // 防止AI分析并发
  lastScore:    70,      // 上次AI分析得分（本地检测参考基准）
  canvas:       null,    // 复用canvas节省内存
  presenceFrames: 0,     // 连续检测到人脸的帧数
  absenceFrames:  0,     // 连续未检测到人脸的帧数
};

// ===== 启动视觉分析 =====
function startVisionAnalysis() {
  if (!state.stream) return;
  console.log('[Vision] 视觉分析模块启动（实时检测 + AI分析）');

  // 创建复用canvas
  vision.canvas = document.createElement('canvas');
  vision.canvas.width  = 160;
  vision.canvas.height = 120;

  // 立即开始本地实时检测（1秒/次）
  localDetectLoop();
  vision.localTimer = setInterval(localDetectLoop, vision.localInterval);

  // 2秒后开始首次AI分析，之后每20秒一次
  setTimeout(() => {
    captureAndAnalyze();
    vision.aiTimer = setInterval(captureAndAnalyze, vision.interval);
  }, 2000);
}

// ===== 停止视觉分析 =====
function stopVisionAnalysis() {
  if (vision.aiTimer)    { clearInterval(vision.aiTimer);    vision.aiTimer = null; }
  if (vision.localTimer) { clearInterval(vision.localTimer); vision.localTimer = null; }
}

// ===== 本地实时检测（每1秒，无需API，纯本地亮度/像素分析）=====
// 原理：通过分析画面亮度变化、像素均值来判断面试者是否在镜头前
// 以及通过上次AI分析结果做平滑插值，实现"实时"效果
function localDetectLoop() {
  const video = document.getElementById('webcam-small');
  if (!video || video.readyState < 2) return;

  const ctx = vision.canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 160, 120);

  // 分析中心区域像素（人脸通常在画面中央）
  const centerData = ctx.getImageData(40, 20, 80, 80);
  const pixels = centerData.data;

  let totalBrightness = 0;
  let skinToneCount = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
    const brightness = (r + g + b) / 3;
    totalBrightness += brightness;

    // 肤色检测（简单判断是否有人脸区域）
    // 肤色：R高，G中，B低，且R-B > 15
    if (r > 80 && g > 50 && b > 30 && r > b + 15 && r > g - 20) {
      skinToneCount++;
    }
  }

  const pixelCount  = pixels.length / 4;
  const avgBrightness = totalBrightness / pixelCount;
  const skinRatio   = skinToneCount / pixelCount;

  // 判断面试者是否在摄像头前
  const personPresent = skinRatio > 0.08 && avgBrightness > 30 && avgBrightness < 240;

  if (personPresent) {
    vision.presenceFrames++;
    vision.absenceFrames = 0;

    // 连续3帧检测到人 → 恢复正常显示
    if (vision.presenceFrames >= 3) {
      if (vision.snapshots.length === 0) {
        // 首次 AI 分析完成前，显示等待提示而非分数
        showAnalyzingTip();
      } else {
        const displayScore = vision.lastScore;
        // 轻微随机抖动（±3分），模拟实时感
        const jitter = Math.round((Math.random() - 0.5) * 6);
        const score  = Math.max(10, Math.min(100, displayScore + jitter));
        updateScoreDisplay(score);
      }
    }
  } else {
    vision.absenceFrames++;
    vision.presenceFrames = 0;

    // 连续2帧没检测到人 → 立即显示"离开镜头"警告（反应更快）
    if (vision.absenceFrames >= 2) {
      showAbsenceWarning();
    }
  }
}

// 实时更新分数仪表盘（不写入快照，只更新显示）
function updateScoreDisplay(score) {
  const fill  = document.getElementById('conf-meter-fill');
  const scoreEl = document.getElementById('conf-score');
  const badge = document.getElementById('conf-badge');
  if (!fill || !scoreEl) return;

  scoreEl.textContent = score;
  fill.style.width = score + '%';

  if (score >= 75) {
    fill.style.background = 'linear-gradient(90deg, #0eb07a, #3a68f0)';
    badge.textContent = '😊 状态良好';
    badge.className   = 'conf-badge high';
  } else if (score >= 50) {
    fill.style.background = 'linear-gradient(90deg, #e69b00, #3a68f0)';
    badge.textContent = '😐 有些紧张';
    badge.className   = 'conf-badge mid';
  } else {
    fill.style.background = 'linear-gradient(90deg, #d93a3a, #e69b00)';
    badge.textContent = '😰 较为紧张';
    badge.className   = 'conf-badge low';
  }
}

// 首次 AI 分析前提示
function showAnalyzingTip() {
  const badge = document.getElementById('conf-badge');
  const fill  = document.getElementById('conf-meter-fill');
  const tip   = document.getElementById('conf-tip');
  const scoreEl = document.getElementById('conf-score');
  if (!badge) return;

  badge.textContent = '📷 检测中...';
  badge.className   = 'conf-badge mid';
  if (fill) { fill.style.width = '50%'; fill.style.background = 'linear-gradient(90deg, #e69b00, #3a68f0)'; }
  if (scoreEl) scoreEl.textContent = '--';
  if (tip) { tip.textContent = '⏳ 首次 AI 分析进行中，约需 2-20 秒...'; tip.classList.add('active'); }
}

// 离开镜头警告 — 分数清零，停止评估
function showAbsenceWarning() {
  const badge = document.getElementById('conf-badge');
  const fill  = document.getElementById('conf-meter-fill');
  const tip   = document.getElementById('conf-tip');
  const scoreEl = document.getElementById('conf-score');
  if (!badge) return;

  badge.textContent = '👻 未在画面中';
  badge.className   = 'conf-badge low';
  if (fill) { fill.style.width = '0%'; fill.style.background = '#d93a3a'; }
  if (scoreEl) scoreEl.textContent = '0';
  if (tip) { tip.textContent = '⚠️ 请回到摄像头前，保持良好的面试姿态'; tip.classList.add('active'); }
}

// ===== 检测画面中是否有人（供 AI 分析截帧前调用）=====
function isPersonInFrame(video) {
  if (!video || video.readyState < 2) return false;

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width  = 160;
  tempCanvas.height = 120;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 160, 120);

  const centerData = ctx.getImageData(40, 20, 80, 80);
  const pixels = centerData.data;

  let totalBrightness = 0;
  let skinToneCount = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
    totalBrightness += (r + g + b) / 3;
    if (r > 80 && g > 50 && b > 30 && r > b + 15 && r > g - 20) {
      skinToneCount++;
    }
  }

  const pixelCount = pixels.length / 4;
  const avgBrightness = totalBrightness / pixelCount;
  const skinRatio = skinToneCount / pixelCount;

  return skinRatio > 0.08 && avgBrightness > 30 && avgBrightness < 240;
}

// ===== 截帧并发送分析 =====
async function captureAndAnalyze() {
  if (vision.analyzing) return;
  if (!state.stream)    return;

  const video = document.getElementById('webcam-small');
  if (!video || video.readyState < 2) return;

  // 先检查面试者是否在画面内，不在则跳过本次分析
  if (!isPersonInFrame(video)) {
    console.log('[Vision] 未检测到面试者，跳过本次 AI 分析');
    return;
  }

  vision.analyzing = true;

  try {
    // 截取当前帧
    const canvas = document.createElement('canvas');
    canvas.width  = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 320, 240);
    const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];

    // 调用视觉分析接口（本地开发走 proxy.js:8866，Docker 走 Nginx:80 → backend:8001）
    const res = await fetch('/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image:         base64,
        round:         state.round,
        interviewType: state.type,
      }),
    });

    if (!res.ok) throw new Error(`视觉接口错误 ${res.status}`);
    const data = await res.json();

    // 保存快照
    const snapshot = {
      round:     state.round,
      score:     data.score     || 50,
      emotion:   data.emotion   || '平静',
      posture:   data.posture   || '正常',
      energy:    data.energy    || '一般',
      tip:       data.tip       || '',
      time:      new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'}),
      raw:       data,
    };
    vision.snapshots.push(snapshot);
    vision.lastScore = snapshot.score; // 更新基准分，供本地实时检测使用
    vision.avgScore = Math.round(
      vision.snapshots.reduce((s, v) => s + v.score, 0) / vision.snapshots.length
    );

    // 更新 UI
    updateConfidencePanel(snapshot);
    console.log(`[Vision] 第${state.round}题 置信度:${snapshot.score} 表情:${snapshot.emotion}`);

  } catch (e) {
    console.warn('[Vision] 分析失败：', e.message);
  } finally {
    vision.analyzing = false;
  }
}

// ===== 更新左侧置信度面板 =====
function updateConfidencePanel(snap) {
  const panel = document.getElementById('confidence-panel');
  if (!panel) return;

  // 仪表盘分数
  const score = snap.score;
  document.getElementById('conf-score').textContent = score;
  document.getElementById('conf-meter-fill').style.width = score + '%';

  // 颜色调整
  const fill = document.getElementById('conf-meter-fill');
  const badge = document.getElementById('conf-badge');
  if (score >= 75) {
    fill.style.background  = 'linear-gradient(90deg, #0eb07a, #3a68f0)';
    badge.textContent = '😊 状态良好';
    badge.className   = 'conf-badge high';
  } else if (score >= 50) {
    fill.style.background  = 'linear-gradient(90deg, #e69b00, #3a68f0)';
    badge.textContent = '😐 有些紧张';
    badge.className   = 'conf-badge mid';
  } else {
    fill.style.background  = 'linear-gradient(90deg, #d93a3a, #e69b00)';
    badge.textContent = '😰 较为紧张';
    badge.className   = 'conf-badge low';
  }

  // 情绪标签
  setEmotionChip('emo-expression', snap.emotion);
  setEmotionChip('emo-posture',    snap.posture);
  setEmotionChip('emo-energy',     snap.energy);

  // 建议提示
  const tipEl = document.getElementById('conf-tip');
  if (snap.tip) {
    tipEl.textContent = snap.tip;
    tipEl.classList.add('active');
  }
}

function setEmotionChip(id, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const positive = ['自信', '微笑', '放松', '专注', '积极', '端正', '充沛', '良好'];
  const negative  = ['紧张', '焦虑', '分神', '低落', '疲惫', '驼背', '不安', '散漫'];
  el.textContent = label;
  if (positive.some(w => label.includes(w))) {
    el.className = 'emotion-chip positive';
  } else if (negative.some(w => label.includes(w))) {
    el.className = 'emotion-chip negative';
  } else {
    el.className = 'emotion-chip neutral';
  }
}

// ===== 生成视觉分析报告（结果页）=====
function renderVisualReport() {
  if (vision.snapshots.length === 0) return;

  document.getElementById('visual-report').style.display = 'block';

  // 三项均分
  const avgConf    = vision.avgScore;
  const avgEmotion = Math.round(
    vision.snapshots.reduce((s, v) => s + (v.score >= 70 ? 1 : 0), 0)
    / vision.snapshots.length * 100
  );
  const consistency = Math.round(
    100 - (Math.max(...vision.snapshots.map(v => v.score))
         - Math.min(...vision.snapshots.map(v => v.score)))
  );

  document.getElementById('visual-stats').innerHTML = `
    <div class="vstat-card">
      <div class="vstat-score">${avgConf}</div>
      <div class="vstat-label">平均置信度</div>
    </div>
    <div class="vstat-card">
      <div class="vstat-score">${avgEmotion}%</div>
      <div class="vstat-label">积极表现占比</div>
    </div>
    <div class="vstat-card">
      <div class="vstat-score">${Math.max(0, consistency)}</div>
      <div class="vstat-label">状态稳定性</div>
    </div>
  `;

  // 时间轴
  const dots = vision.snapshots.map((v, i) => {
    const cls   = v.score >= 75 ? 'high' : v.score >= 50 ? 'mid' : 'low';
    const label = v.score >= 75 ? '😊' : v.score >= 50 ? '😐' : '😰';
    return `<div class="tdot ${cls}" title="第${v.round}题·${v.time}">
      ${label}
      <div class="tdot-tip">第${v.round}题 ${v.score}分<br>${v.emotion} / ${v.posture}</div>
    </div>`;
  }).join('');

  document.getElementById('visual-timeline').innerHTML = `
    <div class="timeline-title">📊 置信度时间轴</div>
    <div class="timeline-dots">${dots}</div>
  `;

  // 综合建议
  const lowSnaps  = vision.snapshots.filter(v => v.score < 50);
  const highSnaps = vision.snapshots.filter(v => v.score >= 75);
  let advice = '';
  if (highSnaps.length > vision.snapshots.length * 0.6) {
    advice = '✅ 整体表现出色！你在面试中保持了良好的自信状态，表情自然、姿态端正，给面试官留下了积极印象。建议在后续面试中继续保持。';
  } else if (lowSnaps.length > vision.snapshots.length * 0.4) {
    advice = '💡 面试中有几个阶段出现明显紧张，建议加强模拟练习、调整呼吸节奏。回答前可以先停顿2秒，微笑点头，能有效提升自信感知。';
  } else {
    advice = '👍 总体状态较为稳定，偶有紧张但能调节。建议重点关注眼神交流和语速节奏，适当增加微表情的丰富度，让面试官感受到你的热情。';
  }

  document.getElementById('visual-advice').textContent = advice;
}


// =====================================================
//   文件上传 & 专项面试模块
// =====================================================

// 已解析的文件内容
const uploadedFiles = {
  resume:      null,  // { text, summary, fileName }
  jd:          null,
};

let currentUploadTab = 'resume';

// ===== Tab 切换 =====
function switchUploadTab(tab, btn) {
  currentUploadTab = tab;
  document.querySelectorAll('.upload-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.upload-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
}

// ===== 拖拽事件 =====
function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}
function handleDragLeave(e) {
  e.currentTarget.classList.remove('dragover');
}
function handleDrop(e, type) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file, type);
}

// ===== 文件选择 =====
function handleFileSelect(e, type) {
  const file = e.target.files[0];
  if (file) processFile(file, type);
}

// ===== 核心：读取文件并发送给代理解析 =====
async function processFile(file, type) {
  const allowedExts = ['pdf', 'doc', 'docx'];
  const ext = file.name.split('.').pop().toLowerCase();

  if (!allowedExts.includes(ext)) {
    alert('仅支持 PDF 和 Word 文件（.pdf .doc .docx）');
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    alert('文件大小不能超过 10MB');
    return;
  }

  // 显示解析中状态
  showParseStatus(`正在解析 ${file.name}...`);

  try {
    // 读取文件为 base64
    const base64 = await fileToBase64(file);

    // 发送给代理解析
    const res = await fetch('http://localhost:8866/parse-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        fileData: base64,
        fileType: type,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `解析失败 ${res.status}`);
    }

    const data = await res.json();

    // 保存解析结果
    const storeKey = type.includes('resume') ? 'resume' : 'jd';
    uploadedFiles[storeKey] = {
      text:     data.text,
      summary:  data.summary,
      fileName: file.name,
      charCount: data.charCount,
    };

    // 如果是简历，同时进行向量化存储（P2：简历文本向量化）
    if (storeKey === 'resume' && data.text) {
      showParseStatus('正在将简历向量化存储...');
      await vectorizeResume(data.text);
    }

    // 更新 drop zone 外观
    const dropZoneId = 'drop-' + type;
    const dropZone = document.getElementById(dropZoneId);
    if (dropZone) {
      dropZone.classList.add('uploaded');
      dropZone.innerHTML = `
        <div class="drop-icon">✅</div>
        <div class="drop-title" style="color:#0a9060;">${file.name}</div>
        <div class="drop-desc" style="color:#0a9060;">${(file.size/1024).toFixed(0)}KB · ${data.charCount}字 解析成功</div>
        <div class="drop-hint">点击可重新上传</div>
      `;
    }

    // 隐藏状态条
    hideParseStatus();

    // 更新摘要展示
    updateFileSummary();

  } catch (e) {
    hideParseStatus();
    alert('文件解析失败：' + e.message + '\n\n请确保代理服务器正在运行（node proxy.js）');
    console.error('[Upload]', e);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showParseStatus(text) {
  const el = document.getElementById('parse-status');
  const textEl = document.getElementById('parse-status-text');
  if (el) { el.style.display = 'flex'; textEl.textContent = text; }
  document.getElementById('file-summary').style.display = 'none';
}

function hideParseStatus() {
  const el = document.getElementById('parse-status');
  if (el) el.style.display = 'none';
}

function updateFileSummary() {
  const hasResume = !!uploadedFiles.resume;
  const hasJD     = !!uploadedFiles.jd;
  if (!hasResume && !hasJD) return;

  const summaryEl = document.getElementById('file-summary');
  const contentEl = document.getElementById('summary-content');
  if (!summaryEl || !contentEl) return;

  let lines = [];
  if (hasResume) lines.push(`📋 简历：${uploadedFiles.resume.fileName}（${uploadedFiles.resume.charCount}字）\n${uploadedFiles.resume.summary}`);
  if (hasJD)     lines.push(`🏢 JD：${uploadedFiles.jd.fileName}（${uploadedFiles.jd.charCount}字）\n${uploadedFiles.jd.summary}`);

  contentEl.textContent = lines.join('\n\n');
  summaryEl.style.display = 'block';
}

function clearUploadedFiles() {
  uploadedFiles.resume = null;
  uploadedFiles.jd     = null;
  document.getElementById('file-summary').style.display = 'none';
  // 重置所有 drop zone
  ['drop-resume','drop-jd','drop-both-resume','drop-both-jd'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('uploaded');
  });
  // 重置各 drop zone 内容
  resetDropZone('drop-resume', '📋', '上传你的简历', '支持 PDF、Word（.docx）· 点击或拖拽上传', '面试官将根据你的简历经历进行针对性提问');
  resetDropZone('drop-jd',     '🏢', '上传职位描述 JD', '支持 PDF、Word（.docx）· 点击或拖拽上传', '面试官将根据 JD 要求设计针对性考核问题');
  resetDropZone('drop-both-resume', '📋', '简历', 'PDF / Word', '');
  resetDropZone('drop-both-jd',     '🏢', '职位 JD', 'PDF / Word', '');
}

function resetDropZone(id, icon, title, desc, hint) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `
    <div class="drop-icon" style="${id.includes('both')?'font-size:1.5rem;':''}">${icon}</div>
    <div class="drop-title" style="${id.includes('both')?'font-size:0.85rem;':''}">${title}</div>
    <div class="drop-desc">${desc}</div>
    ${hint ? `<div class="drop-hint">${hint}</div>` : ''}
  `;
}

// ===== 把文件内容注入 systemPrompt（内化模式）=====
// 核心原则：让 AI 把资料当作背景知识内化，而不是逐条引用
// 问题要像真实面试官一样自然提问，不暴露"我在看你的资料"
function buildFileContext() {
  const hasResume = !!uploadedFiles.resume;
  const hasJD     = !!uploadedFiles.jd;
  if (!hasResume && !hasJD) return '';

  // 把文档内容作为"私下参考材料"附在最后
  // 关键：用【背景参考】而非【必须照搬】的框架，让 AI 自由发挥
  let context = '';

  context += `

【你在面试前已经私下读过以下材料，将其作为背景知识内化了。】
【面试时不要照搬原文、不要朗读资料、不要说"你的简历里写到..."这类机器人语气。】
【像真实面试官一样：心里知道候选人的背景，自然地聊，顺势追问。】

`;

  if (hasResume && hasJD) {
    context += `你读过这位候选人的简历，也了解目标岗位的要求。面试要围绕"这个人能不能胜任这个岗位"来展开，像正常聊天一样问，不用提"你的简历"或"JD里说"，自然衔接就好。最后给出岗位匹配度（高/中/低）。
`;
  } else if (hasResume) {
    context += `你已经看过候选人的简历，对他/她的背景有了解。提问时直接问，不要说"你简历里写了..."，就像你记住了这些信息，自然地聊起来。
`;
  } else if (hasJD) {
    context += `你清楚这个岗位要什么样的人。围绕岗位核心能力考察，像正常面试那样提问，不用念JD条款。
`;
  }

  // 资料内容放在最后，标记为"私下参考"
  if (hasResume) {
    context += `
[私下参考 - 候选人简历]
${uploadedFiles.resume.text}
[简历结束]
`;
  }
  if (hasJD) {
    context += `
[私下参考 - 目标岗位JD]
${uploadedFiles.jd.text}
[JD结束]
`;
  }

  return context;
}
