"""
向量存储模块 — 基于Chroma的招聘问答库向量管理
职责：Embedding生成、向量入库、相似度检索、简历向量化
"""

import os
import json
import numpy as np
from typing import List, Dict, Any, Optional, Tuple
from sentence_transformers import SentenceTransformer
import chromadb
from chromadb.config import Settings

# === 配置 ===
CHROMA_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "chroma_db")
COLLECTION_NAME = "interview_qa"
RESUME_COLLECTION = "resume_vectors"
EMBEDDING_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"  # 支持中文，轻量高效

# 全局模型（懒加载）
_model = None
_client = None


def get_embedding_model() -> SentenceTransformer:
    """获取Embedding模型（单例）"""
    global _model
    if _model is None:
        print(f"[VectorStore] 正在加载Embedding模型: {EMBEDDING_MODEL}")
        _model = SentenceTransformer(EMBEDDING_MODEL)
        print(f"[VectorStore] 模型加载完成，维度: {_model.get_embedding_dimension()}")
    return _model


def get_chroma_client() -> chromadb.Client:
    """获取Chroma客户端（单例）"""
    global _client
    if _client is None:
        os.makedirs(CHROMA_DB_PATH, exist_ok=True)
        _client = chromadb.Client(
            Settings(
                persist_directory=CHROMA_DB_PATH,
                anonymized_telemetry=False
            )
        )
    return _client


def embed_texts(texts: List[str]) -> List[List[float]]:
    """将文本列表编码为向量"""
    model = get_embedding_model()
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return embeddings.tolist()


def embed_text(text: str) -> List[float]:
    """将单条文本编码为向量"""
    return embed_texts([text])[0]


def get_or_create_collection(name: str):
    """获取或创建集合"""
    client = get_chroma_client()
    try:
        collection = client.get_collection(name=name)
    except Exception:
        collection = client.create_collection(name=name, metadata={"hnsw:space": "cosine"})
    return collection


# ============================================================
# 招聘问答库操作
# ============================================================

def init_interview_collection(qa_data_path: str) -> Dict[str, Any]:
    """
    初始化招聘问答库向量集合
    将JSON格式的问答数据向量化并入库
    """
    with open(qa_data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    questions = data.get("questions", [])
    if not questions:
        return {"status": "error", "message": "问答数据为空"}

    collection = get_or_create_collection(COLLECTION_NAME)

    # 清空旧数据（重新初始化）
    try:
        all_ids = collection.get()["ids"]
        if all_ids:
            collection.delete(ids=all_ids)
            print(f"[VectorStore] 已清空旧数据: {len(all_ids)} 条")
    except Exception:
        pass

    # 批量处理
    batch_size = 32
    total = len(questions)
    inserted = 0

    for i in range(0, total, batch_size):
        batch = questions[i : i + batch_size]
        ids = [q["id"] for q in batch]
        texts = [q["question"] for q in batch]
        embeddings = embed_texts(texts)

        metadatas = []
        documents = []
        for q in batch:
            meta = {
                "category": q["category"],
                "position": q["position"],
                "difficulty": q["difficulty"],
                "type": q["type"],
                "tags": ",".join(q["tags"]),
                "frequency": q.get("frequency", 50),
            }
            metadatas.append(meta)
            # document 存储问题和答案的拼接，便于检索
            documents.append(f"问题：{q['question']}\n答案：{q['answer']}")

        collection.add(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=documents,
        )
        inserted += len(batch)
        print(f"[VectorStore] 已入库: {inserted}/{total}")

    return {
        "status": "success",
        "total": total,
        "inserted": inserted,
        "collection": COLLECTION_NAME,
        "embedding_dim": len(embeddings[0]),
    }


def search_similar_questions(
    query: str,
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
    top_k: int = 5,
) -> List[Dict[str, Any]]:
    """
    向量相似度检索：根据用户问题检索最相关的面试题
    支持按职位分类和难度过滤
    """
    query_vec = embed_text(query)
    collection = get_or_create_collection(COLLECTION_NAME)

    where_filter = {}
    if category:
        where_filter["category"] = category
    if difficulty:
        where_filter["difficulty"] = difficulty

    results = collection.query(
        query_embeddings=[query_vec],
        n_results=top_k,
        where=where_filter if where_filter else None,
        include=["metadatas", "documents", "distances"],
    )

    matches = []
    if results and results["ids"]:
        for i, doc_id in enumerate(results["ids"][0]):
            meta = results["metadatas"][0][i] if results["metadatas"] else {}
            doc = results["documents"][0][i] if results["documents"] else ""
            dist = results["distances"][0][i] if results["distances"] else 0.0
            # cosine距离转相似度
            similarity = round(1.0 - dist, 4)

            # 解析document
            parts = doc.split("\n答案：", 1)
            question_text = parts[0].replace("问题：", "") if parts else ""
            answer_text = parts[1] if len(parts) > 1 else ""

            matches.append({
                "id": doc_id,
                "question": question_text,
                "answer": answer_text,
                "category": meta.get("category", ""),
                "position": meta.get("position", ""),
                "difficulty": meta.get("difficulty", ""),
                "type": meta.get("type", ""),
                "tags": meta.get("tags", "").split(",") if meta.get("tags") else [],
                "frequency": meta.get("frequency", 50),
                "similarity": similarity,
            })

    return matches


# ============================================================
# 简历向量化
# ============================================================

def store_resume_vectors(
    resume_text: str,
    resume_id: str = "user_resume",
    chunk_size: int = 500,
    overlap: int = 100,
) -> Dict[str, Any]:
    """
    将简历文本分块向量化存储
    返回：存储的块数量、每块内容
    """
    # 简单文本分块（按字符数）
    chunks = []
    start = 0
    text_len = len(resume_text)
    while start < text_len:
        end = min(start + chunk_size, text_len)
        chunk = resume_text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start += chunk_size - overlap

    if not chunks:
        return {"status": "error", "message": "简历内容为空"}

    collection = get_or_create_collection(RESUME_COLLECTION)

    # 删除该用户旧简历
    try:
        old = collection.get(where={"resume_id": resume_id})["ids"]
        if old:
            collection.delete(ids=old)
    except Exception:
        pass

    embeddings = embed_texts(chunks)
    ids = [f"{resume_id}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [{"resume_id": resume_id, "chunk_index": i} for i in range(len(chunks))]

    collection.add(
        ids=ids,
        embeddings=embeddings,
        metadatas=metadatas,
        documents=chunks,
    )

    return {
        "status": "success",
        "resume_id": resume_id,
        "chunks": len(chunks),
        "chunk_size": chunk_size,
        "overlap": overlap,
    }


def search_resume_context(query: str, resume_id: str = "user_resume", top_k: int = 3) -> List[str]:
    """在简历向量中检索与查询最相关的文本块"""
    query_vec = embed_text(query)
    collection = get_or_create_collection(RESUME_COLLECTION)

    results = collection.query(
        query_embeddings=[query_vec],
        n_results=top_k,
        where={"resume_id": resume_id},
        include=["documents", "distances"],
    )

    chunks = []
    if results and results["documents"]:
        for doc in results["documents"][0]:
            chunks.append(doc)
    return chunks


# ============================================================
# 统计与运维
# ============================================================

def get_collection_stats() -> Dict[str, Any]:
    """获取向量库统计信息"""
    client = get_chroma_client()
    try:
        qa_count = client.get_collection(COLLECTION_NAME).count()
    except Exception:
        qa_count = 0
    try:
        resume_count = client.get_collection(RESUME_COLLECTION).count()
    except Exception:
        resume_count = 0

    return {
        "qa_collection": {"name": COLLECTION_NAME, "count": qa_count},
        "resume_collection": {"name": RESUME_COLLECTION, "count": resume_count},
        "db_path": CHROMA_DB_PATH,
        "embedding_model": EMBEDDING_MODEL,
    }


def delete_resume_vectors(resume_id: str = "user_resume") -> bool:
    """删除指定用户的简历向量"""
    collection = get_or_create_collection(RESUME_COLLECTION)
    try:
        ids = collection.get(where={"resume_id": resume_id})["ids"]
        if ids:
            collection.delete(ids=ids)
        return True
    except Exception as e:
        print(f"[VectorStore] 删除简历向量失败: {e}")
        return False


if __name__ == "__main__":
    # 本地测试
    qa_path = os.path.join(os.path.dirname(__file__), "..", "data", "interview_questions.json")
    result = init_interview_collection(qa_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    # 测试检索
    test_results = search_similar_questions("Redis缓存相关问题", category="software", top_k=3)
    print("\n检索结果:")
    for r in test_results:
        print(f"  [{r['similarity']:.3f}] {r['question'][:40]}...")
