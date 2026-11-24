"""
AI后端服务 — FastAPI主入口
职责：提供向量检索、RAG问答、简历向量化、日志采集等HTTP API
"""

import os
import sys
import json
import uuid
from datetime import datetime
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

# 将backend目录加入路径
sys.path.insert(0, os.path.dirname(__file__))

from vector_store import (
    init_interview_collection,
    search_similar_questions,
    store_resume_vectors,
    search_resume_context,
    get_collection_stats,
    delete_resume_vectors,
    embed_text,
)
from rag_engine import rag_query, direct_vector_search, set_local_model

# === 配置 ===
QA_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "interview_questions.json")
LOGS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "interview_logs")
os.makedirs(LOGS_DIR, exist_ok=True)

# 本地LoRA模型路径（默认相对backend目录，Docker中可通过环境变量覆盖）
LOCAL_MODEL_PATH = os.getenv(
    "LOCAL_MODEL_PATH",
    os.path.join(os.path.dirname(__file__), "..", "models", "lora-interview", "merged")
)

# 启动时自动初始化标志
AUTO_INIT_VECTOR_DB = os.getenv("AUTO_INIT_VECTOR_DB", "true").lower() == "true"


# ============================================================
# 生命周期管理
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动/关闭生命周期"""
    print("[FastAPI] AI后端服务启动中...")
    if AUTO_INIT_VECTOR_DB and os.path.exists(QA_DATA_PATH):
        print("[FastAPI] 正在自动初始化招聘问答库向量集合...")
        result = init_interview_collection(QA_DATA_PATH)
        print(f"[FastAPI] 初始化结果: {result}")
    else:
        print("[FastAPI] 跳过自动初始化（设置 AUTO_INIT_VECTOR_DB=true 可开启）")

    # 加载本地LoRA模型（如存在）
    if os.path.isdir(LOCAL_MODEL_PATH) and os.path.exists(os.path.join(LOCAL_MODEL_PATH, "config.json")):
        try:
            print(f"[FastAPI] 正在加载本地LoRA模型: {LOCAL_MODEL_PATH}")
            from transformers import AutoModelForCausalLM, AutoTokenizer
            import torch

            tokenizer = AutoTokenizer.from_pretrained(LOCAL_MODEL_PATH, trust_remote_code=True)
            model = AutoModelForCausalLM.from_pretrained(
                LOCAL_MODEL_PATH,
                torch_dtype=torch.float32,
                device_map="auto",
                trust_remote_code=True,
            )
            set_local_model(model, tokenizer)
            print(f"[FastAPI] 本地模型加载成功 | 设备: {model.device}")
        except Exception as e:
            print(f"[FastAPI] 本地模型加载失败（将仅使用API模式）: {e}")
    else:
        print(f"[FastAPI] 本地模型未找到（路径: {LOCAL_MODEL_PATH}），仅启用API模式")

    yield
    print("[FastAPI] AI后端服务已关闭")


app = FastAPI(
    title="智能面试助手 — AI后端服务",
    description="基于LLM与招聘大数据的智能面试助手后端，提供RAG检索、简历向量化、日志分析等能力",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# Pydantic 模型定义
# ============================================================

class VectorSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, description="搜索查询文本")
    category: Optional[str] = Field(None, description="职位分类过滤: software/product/design/marketing/data")
    difficulty: Optional[str] = Field(None, description="难度过滤: easy/medium/hard")
    top_k: int = Field(5, ge=1, le=20, description="返回结果数量")


class RAGQueryRequest(BaseModel):
    query: str = Field(..., min_length=1, description="用户问题")
    category: Optional[str] = Field(None, description="职位分类")
    difficulty: Optional[str] = Field(None, description="难度过滤")
    use_resume: bool = Field(False, description="是否使用简历RAG增强")
    resume_id: str = Field("user_resume", description="简历ID")
    top_k: int = Field(3, ge=1, le=10, description="检索Top K条")
    model_type: str = Field("api", description="模型类型: api -> DeepSeek API | local -> 本地LoRA模型")


class ResumeVectorizeRequest(BaseModel):
    resume_text: str = Field(..., min_length=10, description="简历纯文本内容")
    resume_id: str = Field("user_resume", description="简历唯一标识")
    chunk_size: int = Field(500, ge=100, le=2000, description="分块大小")
    overlap: int = Field(100, ge=0, le=500, description="分块重叠大小")


class InterviewLogRequest(BaseModel):
    session_id: str = Field(..., description="面试会话ID")
    round_num: int = Field(..., ge=1, description="面试轮次")
    question: str = Field(..., description="面试问题")
    user_answer: str = Field(..., description="用户回答")
    ai_evaluation: Optional[str] = Field(None, description="AI评价")
    score: Optional[int] = Field(None, ge=0, le=100, description="本轮得分")
    duration_sec: Optional[int] = Field(None, description="回答用时（秒）")
    job_category: Optional[str] = Field(None, description="职位分类")
    interview_type: Optional[str] = Field(None, description="面试官类型")
    metadata: Optional[Dict[str, Any]] = Field(None, description="额外元数据")


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    vector_db: Dict[str, Any]


# ============================================================
# API 路由 — 健康检查 & 状态
# ============================================================

@app.get("/", response_model=HealthResponse)
async def health_check():
    """健康检查与状态概览"""
    stats = get_collection_stats()
    return HealthResponse(
        status="healthy",
        service="智能面试助手AI后端",
        version="1.0.0",
        vector_db=stats,
    )


@app.get("/stats")
async def get_stats():
    """获取向量库详细统计"""
    return get_collection_stats()


# ============================================================
# API 路由 — P1 向量检索
# ============================================================

@app.post("/vector/search")
async def vector_search(req: VectorSearchRequest):
    """
    向量相似度检索：根据用户问题检索最相关的面试题
    支持按职位分类和难度过滤
    """
    try:
        results = search_similar_questions(
            query=req.query,
            category=req.category,
            difficulty=req.difficulty,
            top_k=req.top_k,
        )
        return {
            "status": "success",
            "query": req.query,
            "filters": {"category": req.category, "difficulty": req.difficulty},
            "total": len(results),
            "results": results,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"检索失败: {str(e)}")


@app.post("/vector/init")
async def vector_init(background_tasks: BackgroundTasks):
    """
    手动触发招聘问答库向量集合初始化
    会清空旧数据并重新向量化入库
    """
    if not os.path.exists(QA_DATA_PATH):
        raise HTTPException(status_code=404, detail=f"问答数据文件不存在: {QA_DATA_PATH}")

    try:
        result = init_interview_collection(QA_DATA_PATH)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"初始化失败: {str(e)}")


@app.post("/vector/embed")
async def vector_embed(text: str):
    """单条文本向量化（调试用）"""
    try:
        embedding = embed_text(text)
        return {
            "status": "success",
            "text": text,
            "embedding_dim": len(embedding),
            "embedding": embedding[:5] + ["..."] + embedding[-5:],  # 只展示前后5维
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"向量化失败: {str(e)}")


# ============================================================
# API 路由 — P2 RAG问答
# ============================================================

@app.post("/rag/query")
async def rag_query_endpoint(req: RAGQueryRequest):
    """
    完整RAG查询链路：
    向量检索 → 上下文组装 → LLM生成回答
    支持 model_type 切换：api（DeepSeek）/ local（本地LoRA）
    """
    try:
        result = await rag_query(
            user_question=req.query,
            job_category=req.category,
            difficulty=req.difficulty,
            use_resume=req.use_resume,
            resume_id=req.resume_id,
            top_k=req.top_k,
            model_type=req.model_type,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAG查询失败: {str(e)}")


@app.post("/rag/search-only")
async def rag_search_only(req: VectorSearchRequest):
    """仅向量检索，不调用LLM（用于前端快速展示相关题目）"""
    try:
        results = direct_vector_search(
            query=req.query,
            category=req.category,
            top_k=req.top_k,
        )
        return {
            "status": "success",
            "query": req.query,
            "total": len(results),
            "results": results,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"检索失败: {str(e)}")


# ============================================================
# API 路由 — P2 简历向量化
# ============================================================

@app.post("/resume/vectorize")
async def resume_vectorize(req: ResumeVectorizeRequest):
    """
    将简历文本分块向量化存储
    支持自定义分块大小和重叠量
    """
    try:
        result = store_resume_vectors(
            resume_text=req.resume_text,
            resume_id=req.resume_id,
            chunk_size=req.chunk_size,
            overlap=req.overlap,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"简历向量化失败: {str(e)}")


@app.post("/resume/search")
async def resume_search(query: str, resume_id: str = "user_resume", top_k: int = 3):
    """在简历向量中检索与查询最相关的文本块"""
    try:
        chunks = search_resume_context(query, resume_id=resume_id, top_k=top_k)
        return {
            "status": "success",
            "query": query,
            "resume_id": resume_id,
            "chunks_found": len(chunks),
            "chunks": chunks,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"简历检索失败: {str(e)}")


@app.delete("/resume/{resume_id}")
async def resume_delete(resume_id: str):
    """删除指定用户的简历向量"""
    success = delete_resume_vectors(resume_id)
    if success:
        return {"status": "success", "message": f"简历 {resume_id} 向量已删除"}
    else:
        raise HTTPException(status_code=500, detail="删除失败")


# ============================================================
# API 路由 — P5 日志采集与分析
# ============================================================

@app.post("/log/interview")
async def log_interview(req: InterviewLogRequest):
    """
    采集单条面试问答日志
    存储为JSONL格式，便于后续分析
    """
    try:
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "session_id": req.session_id,
            "round_num": req.round_num,
            "question": req.question,
            "user_answer": req.user_answer,
            "ai_evaluation": req.ai_evaluation,
            "score": req.score,
            "duration_sec": req.duration_sec,
            "job_category": req.job_category,
            "interview_type": req.interview_type,
            "metadata": req.metadata or {},
        }

        # 按日期分文件存储
        date_str = datetime.now().strftime("%Y%m%d")
        log_file = os.path.join(LOGS_DIR, f"interview_{date_str}.jsonl")

        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

        return {"status": "success", "message": "日志已记录", "log_id": str(uuid.uuid4())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"日志记录失败: {str(e)}")


@app.get("/log/analysis")
async def log_analysis(days: int = 7):
    """
    面试问答日志分析
    返回：总面试数、平均得分、各职位分布、高频问题等统计
    """
    try:
        all_entries = []
        for filename in sorted(os.listdir(LOGS_DIR)):
            if not filename.endswith(".jsonl"):
                continue
            filepath = os.path.join(LOGS_DIR, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entry = json.loads(line)
                            all_entries.append(entry)
                        except json.JSONDecodeError:
                            continue

        if not all_entries:
            return {
                "status": "success",
                "total_sessions": 0,
                "total_rounds": 0,
                "message": "暂无日志数据",
            }

        # 统计分析
        total_rounds = len(all_entries)
        sessions = set(e["session_id"] for e in all_entries)
        total_sessions = len(sessions)

        scores = [e["score"] for e in all_entries if e.get("score") is not None]
        avg_score = round(sum(scores) / len(scores), 2) if scores else 0

        # 职位分布
        category_dist = {}
        for e in all_entries:
            cat = e.get("job_category", "unknown")
            category_dist[cat] = category_dist.get(cat, 0) + 1

        # 面试官类型分布
        type_dist = {}
        for e in all_entries:
            t = e.get("interview_type", "unknown")
            type_dist[t] = type_dist.get(t, 0) + 1

        # 平均回答时长
        durations = [e["duration_sec"] for e in all_entries if e.get("duration_sec")]
        avg_duration = round(sum(durations) / len(durations), 1) if durations else 0

        return {
            "status": "success",
            "period_days": days,
            "total_sessions": total_sessions,
            "total_rounds": total_rounds,
            "avg_score": avg_score,
            "avg_duration_sec": avg_duration,
            "category_distribution": category_dist,
            "type_distribution": type_dist,
            "sample_entries": all_entries[:3],  # 返回前3条作为样例
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"日志分析失败: {str(e)}")


# ============================================================
# API 路由 — 视觉分析（表情识别 + 姿态评估）
# ============================================================

import requests
import re

# 阿里云百炼 Qwen-VL 配置（视觉分析用）
QWEN_API_KEY = os.getenv("QWEN_API_KEY", "")
QWEN_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

VISION_PROMPT = """你是一位专业的面试评估师，正在通过摄像头画面分析面试者的非语言表现。

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

只返回 JSON，不要有任何其他文字。"""


class VisionRequest(BaseModel):
    image: str = Field(..., description="Base64 编码的 JPEG 图片（不含 data URI 前缀）")
    round: int = Field(0, description="当前面试轮次")
    interviewType: str = Field("gentle", description="面试官类型")


@app.post("/vision")
async def vision_analyze(req: VisionRequest):
    """
    视觉分析：调用 Qwen-VL 模型分析面试者表情、姿态、置信度
    """
    if not req.image:
        raise HTTPException(status_code=400, detail="缺少图片数据")
    if not QWEN_API_KEY:
        raise HTTPException(status_code=503, detail="QWEN_API_KEY is not configured")

    try:
        payload = {
            "model": "qwen-vl-max",
            "max_tokens": 300,
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{req.image}"}
                    },
                    {"type": "text", "text": VISION_PROMPT}
                ]
            }]
        }

        response = requests.post(
            QWEN_API_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {QWEN_API_KEY}",
            },
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()

        if data.get("error"):
            raise HTTPException(status_code=500, detail=f"Qwen-VL 错误: {data['error']}")
        if not data.get("choices") or not data["choices"][0]:
            raise HTTPException(status_code=500, detail="Qwen-VL 无返回内容")

        # 解析 JSON 响应（提取 JSON 块，防止有多余文字）
        raw_text = data["choices"][0]["message"]["content"].strip()
        json_match = re.search(r"\{[\s\S]*\}", raw_text)
        try:
            result = json.loads(json_match.group(0) if json_match else raw_text)
        except json.JSONDecodeError:
            result = {
                "score": 60,
                "emotion": "表情自然",
                "posture": "姿态正常",
                "energy": "状态一般",
                "tip": "保持自信，展现最好的自己"
            }

        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"视觉分析失败: {str(e)}")


# ============================================================
# API 路由 — TTS 语音合成代理
# ============================================================

# 火山引擎 TTS 配置
VOLC_APP_ID = os.getenv("VOLC_APP_ID", "")
VOLC_TOKEN = os.getenv("VOLC_TOKEN", "")
VOLC_TTS_URL = "https://openspeech.bytedance.com/api/v1/tts"

VOICE_MAP = {
    "male": {
        "strict":       { "voice_type": "BV102_streaming", "speed_ratio": 1.15, "pitch_ratio": 0.88, "volume_ratio": 1.0 },
        "gentle":       { "voice_type": "BV113_streaming", "speed_ratio": 0.95, "pitch_ratio": 1.0,  "volume_ratio": 1.0 },
        "enthusiastic": { "voice_type": "BV056_streaming", "speed_ratio": 1.1,  "pitch_ratio": 1.05, "volume_ratio": 1.05 },
    },
    "female": {
        "strict":       { "voice_type": "BV001_streaming", "speed_ratio": 1.12, "pitch_ratio": 0.95, "volume_ratio": 1.0 },
        "gentle":       { "voice_type": "BV001_streaming", "speed_ratio": 0.92, "pitch_ratio": 1.06, "volume_ratio": 1.0 },
        "enthusiastic": { "voice_type": "BV700_streaming", "speed_ratio": 1.1,  "pitch_ratio": 1.12, "volume_ratio": 1.05 },
    },
}


class TTSRequest(BaseModel):
    text: str
    interviewerType: str = "gentle"
    hrGender: str = "female"


@app.post("/tts")
async def tts_synthesize(req: TTSRequest):
    """
    火山引擎 TTS 代理：将前端请求转发到火山引擎，返回 base64 音频
    """
    try:
        if not VOLC_APP_ID or not VOLC_TOKEN:
            raise HTTPException(status_code=503, detail="VOLC_APP_ID and VOLC_TOKEN are not configured")

        gender = req.hrGender if req.hrGender in VOICE_MAP else "female"
        voice_cfg = VOICE_MAP[gender].get(req.interviewerType, VOICE_MAP[gender]["gentle"])

        payload = {
            "app": {
                "appid": VOLC_APP_ID,
                "token": VOLC_TOKEN,
                "cluster": "volcano_tts",
            },
            "user": { "uid": "interview_user" },
            "audio": {
                "voice_type": voice_cfg["voice_type"],
                "encoding": "mp3",
                "speed_ratio": voice_cfg["speed_ratio"],
                "volume_ratio": voice_cfg["volume_ratio"],
                "pitch_ratio": voice_cfg["pitch_ratio"],
            },
            "request": {
                "reqid": str(uuid.uuid4()).replace("-", ""),
                "text": req.text,
                "operation": "query",
            },
        }

        response = requests.post(
            VOLC_TTS_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer;{VOLC_TOKEN}",
            },
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()

        if data.get("code") != 3000 or not data.get("data"):
            raise HTTPException(status_code=500, detail=f"TTS失败: {data.get('message', '未知错误')}")

        return { "audio": data["data"] }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS代理错误: {str(e)}")


# ============================================================
# 启动入口
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
