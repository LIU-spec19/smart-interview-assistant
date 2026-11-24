"""
RAG引擎 — 检索增强生成链路
职责：向量检索 → 上下文组装 → Prompt构建 → 调用LLM生成回答
支持：招聘问答检索、简历RAG、混合检索策略
"""

import os
import json
import requests
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

from vector_store import search_similar_questions, search_resume_context

# === 配置 ===
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions"
LOCAL_LLM_URL = os.getenv("LOCAL_LLM_URL", "http://localhost:8001/v1/chat/completions")

# 使用本地模型还是API
USE_LOCAL_LLM = os.getenv("USE_LOCAL_LLM", "false").lower() == "true"


def build_rag_prompt(
    user_question: str,
    retrieved_qa: List[Dict[str, Any]],
    resume_chunks: Optional[List[str]] = None,
    job_category: Optional[str] = None,
    interview_type: str = "general",
    model_type: str = "api",
) -> str:
    """
    构建RAG Prompt
    根据 model_type 生成不同强度的 prompt：
    - local: 极简prompt，让微调模型自由发挥原味
    - api: 保留功能约束但给DeepSeek更多表达空间
    """
    # 组装检索到的问答库上下文
    qa_context = ""
    if retrieved_qa:
        qa_context = "【招聘问答库参考】\n以下是与用户问题相关的面试题及参考答案，请作为回答依据：\n\n"
        for i, qa in enumerate(retrieved_qa, 1):
            qa_context += f"[{i}] 问题：{qa['question']}\n"
            qa_context += f"    答案：{qa['answer'][:300]}...\n"
            qa_context += f"    [职位：{qa['position']} | 难度：{qa['difficulty']} | 相关度：{qa['similarity']:.2%}]\n\n"

    # 组装简历上下文
    resume_context = ""
    if resume_chunks:
        resume_context = "【候选人简历参考】\n以下是候选人的简历相关信息：\n\n"
        for i, chunk in enumerate(resume_chunks, 1):
            resume_context += f"[简历片段{i}] {chunk[:400]}...\n\n"

    # 职位映射
    category_names = {
        "software": "软件工程师",
        "product": "产品经理",
        "design": "UI/UX设计师",
        "marketing": "市场营销",
        "data": "数据分析师",
    }
    position_name = category_names.get(job_category, "通用职位")

    # 面试官性格描述（用于本地模型极简prompt）
    type_personality = {
        "strict": "严厉直接，要求高，不喜欢废话",
        "gentle": "温和有耐心，循循善诱",
        "enthusiastic": "热情开朗，互动多，氛围轻松",
        "general": "专业严谨",
    }.get(interview_type, "专业严谨")

    if model_type == "local":
        # ===== 本地LoRA模型：极简prompt，让它自由发挥微调学到的原味 =====
        system_prompt = f"""你叫面试官，是一位{position_name}岗位的HR，性格{type_personality}。
你正在面试一位候选人。你的任务是点评候选人的回答，然后提出下一个问题。
最后一轮面试结束时，给出总结和评分即可，不用再提问。
不要直接给候选人标准答案，你是来考察他的。

{qa_context}
{resume_context}
"""
    else:
        # ===== DeepSeek API：保留功能约束，但给更多表达空间，展现DeepSeek特色 =====
        system_prompt = f"""你是一位专业的{position_name}面试官，正在进行一场真实的面试。

【核心原则】
- 你是面试官，目标是考察候选人，不是教他
- 招聘问答库仅供你内部参考，不要把答案直接展示给候选人
- 不要泄露下一道题的内容

【面试流程】
- 如果是第1题到第5题：简短点评候选人回答后，自然流畅地提出下一题
- 如果是最后一题（第6题）：点评后给出面试总结和综合评分，不要再提问
- 总结简洁一些，包含评价、分数和建议即可

【表达风格】
- 像真人一样说话，口语化，不要像机器
- 点评聚焦在候选人实际回答的内容，不要补充标准答案
- 你可以展现自己的逻辑和判断风格，这是你的特色

{qa_context}
{resume_context}
"""
    return system_prompt


# ============================================================
# 本地模型支持（LoRA 微调模型）
# ============================================================

_local_model = None
_local_tokenizer = None

def set_local_model(model, tokenizer):
    """由 main.py 在启动时注入本地模型实例"""
    global _local_model, _local_tokenizer
    _local_model = model
    _local_tokenizer = tokenizer


def _generate_local(messages, temperature, max_tokens):
    """同步本地模型推理（在 to_thread 中运行）"""
    import torch

    prompt = _local_tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = _local_tokenizer(prompt, return_tensors="pt")
    inputs = {k: v.to(_local_model.device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = _local_model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=temperature,
            do_sample=True,
            pad_token_id=_local_tokenizer.pad_token_id,
            eos_token_id=_local_tokenizer.eos_token_id,
        )

    generated = outputs[0][inputs["input_ids"].shape[1]:]
    answer = _local_tokenizer.decode(generated, skip_special_tokens=True)

    return {
        "status": "success",
        "answer": answer,
        "model": "local-lora",
        "prompt_tokens": inputs["input_ids"].shape[1],
        "completion_tokens": len(generated),
        "total_tokens": inputs["input_ids"].shape[1] + len(generated),
    }


async def call_local_llm(messages, temperature=0.7, max_tokens=800):
    """异步包装本地模型推理"""
    import asyncio
    return await asyncio.to_thread(_generate_local, messages, temperature, max_tokens)


def call_api_llm(messages, temperature=0.7, max_tokens=800):
    """调用 DeepSeek API"""
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")

    payload = {
        "model": "deepseek-chat",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
    }
    response = requests.post(DEEPSEEK_API_URL, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()
    answer = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})

    return {
        "status": "success",
        "answer": answer,
        "model": data.get("model", "unknown"),
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


async def call_llm(
    system_prompt: str,
    user_question: str,
    model_type: str = "api",
    temperature: float = 0.7,
    max_tokens: int = 800,
) -> Dict[str, Any]:
    """
    调用LLM生成回答
    model_type: "api" -> DeepSeek API | "local" -> 本地LoRA模型
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_question},
    ]

    try:
        if model_type == "local" and _local_model is not None:
            result = await call_local_llm(messages, temperature, max_tokens)
        else:
            result = call_api_llm(messages, temperature, max_tokens)
        return result

    except Exception as e:
        return {
            "status": "error",
            "answer": f"模型调用失败: {str(e)}",
            "model": "none",
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }


async def rag_query(
    user_question: str,
    job_category: Optional[str] = None,
    difficulty: Optional[str] = None,
    use_resume: bool = False,
    resume_id: str = "user_resume",
    top_k: int = 3,
    model_type: str = "api",
) -> Dict[str, Any]:
    """
    完整的RAG查询链路：
    1. 向量检索相关面试题
    2. 检索简历上下文（可选）
    3. 构建RAG Prompt
    4. 调用LLM生成回答（支持 api / local 双模型切换）
    5. 返回结果+检索来源
    """
    # 1. 检索问答库
    retrieved_qa = search_similar_questions(
        query=user_question,
        category=job_category,
        difficulty=difficulty,
        top_k=top_k,
    )

    # 2. 检索简历上下文
    resume_chunks = None
    if use_resume:
        resume_chunks = search_resume_context(user_question, resume_id=resume_id, top_k=3)

    # 3. 构建Prompt（根据 model_type 选择不同强度的system prompt）
    system_prompt = build_rag_prompt(
        user_question=user_question,
        retrieved_qa=retrieved_qa,
        resume_chunks=resume_chunks,
        job_category=job_category,
        model_type=model_type,
    )

    # 4. 调用LLM（根据 model_type 选择 api 或 local）
    llm_result = await call_llm(system_prompt, user_question, model_type=model_type)

    # 5. 组装结果
    return {
        "status": llm_result["status"],
        "query": user_question,
        "answer": llm_result["answer"],
        "model_used": llm_result["model"],
        "retrieved_sources": [
            {
                "id": qa["id"],
                "question": qa["question"],
                "similarity": qa["similarity"],
                "category": qa["category"],
                "difficulty": qa["difficulty"],
            }
            for qa in retrieved_qa
        ],
        "resume_used": use_resume and bool(resume_chunks),
        "tokens": {
            "prompt": llm_result["prompt_tokens"],
            "completion": llm_result["completion_tokens"],
            "total": llm_result["total_tokens"],
        },
    }


def direct_vector_search(
    query: str,
    category: Optional[str] = None,
    top_k: int = 5,
) -> List[Dict[str, Any]]:
    """
    仅做向量检索，不调用LLM
    用于前端快速展示相关面试题
    """
    return search_similar_questions(query, category=category, top_k=top_k)


if __name__ == "__main__":
    import asyncio
    # 本地测试RAG链路
    result = asyncio.run(rag_query(
        user_question="Redis缓存雪崩怎么解决？",
        job_category="software",
        top_k=3,
    ))
    print("=" * 60)
    print(f"问题: {result['query']}")
    print(f"回答:\n{result['answer']}")
    print(f"\n检索来源: {len(result['retrieved_sources'])} 条")
    for src in result["retrieved_sources"]:
        print(f"  - [{src['similarity']:.2%}] {src['question'][:50]}")
