#!/usr/bin/env python3
"""
向量库初始化脚本
用法: python scripts/init_vector_db.py [--data data/interview_questions.json]

功能：
1. 加载招聘问答库JSON数据
2. 使用Sentence-Transformer生成Embedding
3. 存入Chroma向量数据库
4. 输出统计信息
"""

import os
import sys
import argparse
import json

# 将项目根目录加入路径
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "backend"))

from vector_store import init_interview_collection, get_collection_stats, search_similar_questions


def main():
    parser = argparse.ArgumentParser(description="初始化招聘问答库向量数据库")
    parser.add_argument(
        "--data",
        type=str,
        default=os.path.join(PROJECT_ROOT, "data", "interview_questions.json"),
        help="问答库JSON文件路径",
    )
    parser.add_argument(
        "--test-query",
        type=str,
        default="Redis缓存相关问题",
        help="初始化后执行的测试查询",
    )
    parser.add_argument(
        "--test-category",
        type=str,
        default="software",
        help="测试查询的职位分类",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("招聘问答库向量数据库初始化工具")
    print("=" * 60)

    # 检查数据文件
    if not os.path.exists(args.data):
        print(f"[错误] 数据文件不存在: {args.data}")
        sys.exit(1)

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)
    total_qa = len(data.get("questions", []))
    print(f"[信息] 加载问答数据: {total_qa} 条")

    # 执行初始化
    print("\n[步骤1/3] 正在向量化并入库...")
    result = init_interview_collection(args.data)

    if result["status"] != "success":
        print(f"[错误] 初始化失败: {result.get('message', '未知错误')}")
        sys.exit(1)

    print(f"[成功] 已入库 {result['inserted']}/{result['total']} 条")
    print(f"[信息] Embedding维度: {result['embedding_dim']}")
    print(f"[信息] 集合名称: {result['collection']}")

    # 统计信息
    print("\n[步骤2/3] 向量库统计:")
    stats = get_collection_stats()
    print(f"  - 问答库集合: {stats['qa_collection']['name']} ({stats['qa_collection']['count']} 条)")
    print(f"  - 简历集合: {stats['resume_collection']['name']} ({stats['resume_collection']['count']} 条)")
    print(f"  - 存储路径: {stats['db_path']}")
    print(f"  - Embedding模型: {stats['embedding_model']}")

    # 测试检索
    print(f"\n[步骤3/3] 测试检索: '{args.test_query}'")
    test_results = search_similar_questions(
        query=args.test_query,
        category=args.test_category,
        top_k=3,
    )
    print(f"[结果] 找到 {len(test_results)} 条相关面试题:")
    for i, r in enumerate(test_results, 1):
        print(f"  {i}. [{r['similarity']:.2%}] {r['question'][:50]}...")
        print(f"     [职位: {r['position']} | 难度: {r['difficulty']} | 类型: {r['type']}]")

    print("\n" + "=" * 60)
    print("初始化完成！您可以启动后端服务进行更多测试。")
    print("启动命令: cd backend && python main.py")
    print("=" * 60)


if __name__ == "__main__":
    main()
