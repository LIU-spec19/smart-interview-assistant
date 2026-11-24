"""
本地LLM推理服务 — 加载LoRA微调后的模型提供HTTP API
职责：使用 llama-cpp-python 或 transformers 加载本地模型，提供OpenAI兼容的chat接口
"""

import os
import sys
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# === 配置 ===
DEFAULT_MODEL_PATH = os.getenv("LOCAL_MODEL_PATH", "")
DEFAULT_LORA_PATH = os.getenv("LOCAL_LORA_PATH", "")

# 优先使用 llama.cpp (GGUF格式) 进行高效本地推理
USE_LLAMA_CPP = os.getenv("USE_LLAMA_CPP", "true").lower() == "true"

# 全局模型实例
_llm = None


def load_model():
    """加载本地模型"""
    global _llm

    if _llm is not None:
        return _llm

    model_path = DEFAULT_MODEL_PATH
    lora_path = DEFAULT_LORA_PATH

    if not model_path or not os.path.exists(model_path):
        print(f"[LocalLLM] 警告: 模型路径不存在: {model_path}")
        return None

    if USE_LLAMA_CPP:
        # 使用 llama.cpp (推荐，CPU也可运行)
        try:
            from llama_cpp import Llama
            print(f"[LocalLLM] 正在加载GGUF模型: {model_path}")
            _llm = Llama(
                model_path=model_path,
                n_ctx=4096,
                n_threads=os.cpu_count() or 4,
                verbose=False,
            )
            # 如果有LoRA适配器（GGUF格式）
            if lora_path and os.path.exists(lora_path):
                print(f"[LocalLLM] 加载LoRA适配器: {lora_path}")
                _llm.set_lora(path=lora_path)
            print("[LocalLLM] GGUF模型加载完成")
            return _llm
        except ImportError:
            print("[LocalLLM] llama-cpp-python 未安装，尝试使用 transformers...")
            USE_LLAMA_CPP = False

    # 使用 transformers + PEFT (需要GPU，显存需求大)
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline
        from peft import PeftModel
        import torch

        print(f"[LocalLLM] 正在加载Transformers模型: {model_path}")
        tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            trust_remote_code=True,
            torch_dtype=torch.float16,
            device_map="auto",
        )

        if lora_path and os.path.exists(lora_path):
            print(f"[LocalLLM] 加载LoRA适配器: {lora_path}")
            model = PeftModel.from_pretrained(model, lora_path)

        _llm = pipeline(
            "text-generation",
            model=model,
            tokenizer=tokenizer,
            max_new_tokens=512,
            temperature=0.7,
            do_sample=True,
        )
        print("[LocalLLM] Transformers模型加载完成")
        return _llm

    except Exception as e:
        print(f"[LocalLLM] 模型加载失败: {e}")
        return None


def generate_llama_cpp(messages: List[Dict[str, str]], max_tokens: int = 512, temperature: float = 0.7) -> str:
    """使用llama.cpp生成回复"""
    llm = load_model()
    if llm is None:
        raise RuntimeError("模型未加载")

    # 构建prompt（简单拼接，实际应使用chat template）
    prompt_parts = []
    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        if role == "system":
            prompt_parts.append(f"<|system|>\n{content}")
        elif role == "user":
            prompt_parts.append(f"<|user|>\n{content}")
        elif role == "assistant":
            prompt_parts.append(f"<|assistant|>\n{content}")
    prompt_parts.append("<|assistant|>\n")
    prompt = "\n".join(prompt_parts)

    output = llm(
        prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        stop=["<|user|>", "<|system|>"],
    )
    return output["choices"][0]["text"].strip()


def generate_transformers(messages: List[Dict[str, str]], max_tokens: int = 512, temperature: float = 0.7) -> str:
    """使用transformers生成回复"""
    pipe = load_model()
    if pipe is None:
        raise RuntimeError("模型未加载")

    # 使用tokenizer的chat template
    tokenizer = pipe.tokenizer
    prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    outputs = pipe(
        prompt,
        max_new_tokens=max_tokens,
        temperature=temperature,
        do_sample=True,
        return_full_text=False,
    )
    return outputs[0]["generated_text"].strip()


# ============================================================
# FastAPI 服务
# ============================================================

app = FastAPI(
    title="本地LLM推理服务",
    description="加载LoRA微调后的模型，提供OpenAI兼容的chat接口",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = Field("local-lora-model", description="模型标识")
    messages: List[ChatMessage]
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(512, ge=1, le=4096)


class ChatResponse(BaseModel):
    id: str
    object: str
    created: int
    model: str
    choices: List[Dict[str, Any]]
    usage: Dict[str, int]


@app.on_event("startup")
async def startup():
    """启动时加载模型"""
    print("[LocalLLM] 服务启动中，正在加载模型...")
    load_model()
    print("[LocalLLM] 服务就绪")


@app.get("/")
async def health():
    """健康检查"""
    model_loaded = _llm is not None
    return {
        "status": "healthy" if model_loaded else "model_not_loaded",
        "model_path": DEFAULT_MODEL_PATH,
        "lora_path": DEFAULT_LORA_PATH,
        "backend": "llama.cpp" if USE_LLAMA_CPP else "transformers",
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    """
    OpenAI兼容的chat接口
    用于替换或补充DeepSeek API
    """
    if _llm is None:
        raise HTTPException(status_code=503, detail="本地模型未加载，请检查模型路径配置")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    try:
        if USE_LLAMA_CPP:
            answer = generate_llama_cpp(messages, max_tokens=req.max_tokens, temperature=req.temperature)
        else:
            answer = generate_transformers(messages, max_tokens=req.max_tokens, temperature=req.temperature)

        import time
        return ChatResponse(
            id=f"chatcmpl-{int(time.time())}",
            object="chat.completion",
            created=int(time.time()),
            model=req.model,
            choices=[{
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop",
            }],
            usage={
                "prompt_tokens": len(str(messages)),
                "completion_tokens": len(answer),
                "total_tokens": len(str(messages)) + len(answer),
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002, log_level="info")
