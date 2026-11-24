#!/usr/bin/env python3
"""
LoRA微调训练脚本（Mac MPS适配版）
用法: python scripts/lora_train.py --model Qwen/Qwen2.5-1.5B-Instruct --output models/lora-interview

功能：
1. 加载问答库数据，转换为指令微调格式
2. 使用PEFT+LoRA对基座模型进行微调
3. 适配Mac MPS（Apple Silicon GPU）训练
4. 保存适配器权重和训练配置
5. 支持合并权重导出为完整模型（可选）
"""

import os
import sys
import json
import argparse
import torch
from pathlib import Path

# 将项目根目录加入路径
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "backend"))

from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
    DataCollatorForSeq2Seq,
)
from peft import LoraConfig, get_peft_model, TaskType
from datasets import Dataset


# === 默认配置（Mac MPS适配）===
DEFAULT_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"  # 1.5B适合Mac 24GB内存
DEFAULT_OUTPUT = os.path.join(PROJECT_ROOT, "models", "lora-interview")
QA_DATA_PATH = os.path.join(PROJECT_ROOT, "data", "interview_questions.json")


def get_device_info():
    """检测可用设备（CUDA / MPS / CPU）"""
    if torch.cuda.is_available():
        return "cuda", torch.float16
    elif torch.backends.mps.is_available():
        return "mps", torch.float32  # MPS对fp16支持不完整，用fp32更稳
    else:
        return "cpu", torch.float32


def build_training_data(qa_path: str, max_samples: int = None) -> Dataset:
    """
    将问答库转换为指令微调格式 (Alpaca格式)
    每个样本：instruction + input → output
    """
    with open(qa_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    questions = data.get("questions", [])
    if max_samples:
        questions = questions[:max_samples]

    records = []
    for q in questions:
        position = q.get("position", "通用职位")
        difficulty = q.get("difficulty", "medium")
        question_type = q.get("type", "technical")

        instruction = (
            f"你是一位专业的{position}面试官。"
            f"请针对以下{difficulty}难度的{question_type}类面试问题，"
            f"给出专业、结构清晰的中文回答。"
        )

        records.append({
            "instruction": instruction,
            "input": q["question"],
            "output": q["answer"],
        })

    def format_chat(example):
        messages = [
            {"role": "system", "content": example["instruction"]},
            {"role": "user", "content": example["input"]},
            {"role": "assistant", "content": example["output"]},
        ]
        return {"messages": messages}

    dataset = Dataset.from_list(records)
    dataset = dataset.map(format_chat, remove_columns=dataset.column_names)
    return dataset


def apply_chat_template(dataset: Dataset, tokenizer, max_length: int = 2048):
    """应用对话模板并tokenize"""

    def process(examples):
        texts = []
        for messages in examples["messages"]:
            text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=False,
            )
            texts.append(text)

        tokenized = tokenizer(
            texts,
            max_length=max_length,
            truncation=True,
            padding=False,
            return_tensors=None,
        )
        tokenized["labels"] = tokenized["input_ids"].copy()
        return tokenized

    return dataset.map(
        process,
        batched=True,
        remove_columns=dataset.column_names,
    )


def main():
    parser = argparse.ArgumentParser(description="LoRA微调面试问答模型（Mac MPS版）")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="基座模型名称或路径")
    parser.add_argument("--output", type=str, default=DEFAULT_OUTPUT, help="输出目录")
    parser.add_argument("--data", type=str, default=QA_DATA_PATH, help="问答库JSON路径")
    parser.add_argument("--max-samples", type=int, default=None, help="最大训练样本数")
    parser.add_argument("--epochs", type=int, default=3, help="训练轮数")
    parser.add_argument("--batch-size", type=int, default=2, help="训练批次大小（Mac建议2）")
    parser.add_argument("--lr", type=float, default=2e-4, help="学习率")
    parser.add_argument("--lora-r", type=int, default=32, help="LoRA秩（Mac建议32）")
    parser.add_argument("--lora-alpha", type=int, default=64, help="LoRA alpha")
    parser.add_argument("--max-length", type=int, default=2048, help="最大序列长度")
    parser.add_argument("--merge-weights", action="store_true", help="训练后合并权重导出完整模型")
    args = parser.parse_args()

    # 检测设备
    device, dtype = get_device_info()
    print("=" * 70)
    print("LoRA微调 — 招聘面试问答模型（Mac MPS适配版）")
    print("=" * 70)
    print(f"基座模型: {args.model}")
    print(f"输出目录: {args.output}")
    print(f"训练数据: {args.data}")
    print(f"训练轮数: {args.epochs} | 批次: {args.batch_size} | 学习率: {args.lr}")
    print(f"LoRA配置: r={args.lora_r}, alpha={args.lora_alpha}")
    print(f"训练设备: {device.upper()} | 数据类型: {dtype}")
    print("=" * 70)

    # 1. 加载Tokenizer
    print("\n[1/5] 加载Tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(
        args.model,
        trust_remote_code=True,
        padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # 2. 加载模型（Mac MPS适配）
    print("[2/5] 加载基座模型...")
    load_kwargs = {
        "trust_remote_code": True,
        "torch_dtype": dtype,
    }

    if device == "cuda":
        load_kwargs["device_map"] = "auto"
    elif device == "mps":
        load_kwargs["device_map"] = {"": "mps"}
    else:
        load_kwargs["device_map"] = {"": "cpu"}

    model = AutoModelForCausalLM.from_pretrained(args.model, **load_kwargs)

    # 3. 配置LoRA
    print("[3/5] 配置LoRA...")
    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_dropout=0.05,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # 4. 准备训练数据
    print("[4/5] 准备训练数据...")
    dataset = build_training_data(args.data, max_samples=args.max_samples)
    print(f"  原始样本数: {len(dataset)}")
    tokenized_dataset = apply_chat_template(dataset, tokenizer, max_length=args.max_length)
    print(f"  Tokenize完成")

    # 5. 训练参数（Mac MPS适配）
    print("[5/5] 开始训练...")
    os.makedirs(args.output, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=4,
        learning_rate=args.lr,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=2,
        fp16=(dtype == torch.float16),
        bf16=False,
        optim="adamw_torch",  # Mac用标准adamw
        report_to="none",
        remove_unused_columns=False,
        use_mps_device=(device == "mps"),  # 启用MPS设备支持
    )

    data_collator = DataCollatorForSeq2Seq(
        tokenizer=tokenizer,
        model=model,
        label_pad_token_id=-100,
        pad_to_multiple_of=8,
    )

    from trl import SFTTrainer

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=tokenized_dataset,
        args=training_args,
        data_collator=data_collator,
        max_seq_length=args.max_length,
    )

    trainer.train()

    # 6. 保存模型
    print("\n[完成] 保存模型...")
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)

    # 保存训练配置
    config_path = os.path.join(args.output, "training_config.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump({
            "base_model": args.model,
            "lora_r": args.lora_r,
            "lora_alpha": args.lora_alpha,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.lr,
            "max_length": args.max_length,
            "device": device,
            "dtype": str(dtype),
            "data_path": args.data,
        }, f, ensure_ascii=False, indent=2)
    print(f"  配置已保存: {config_path}")

    # 可选：合并权重
    if args.merge_weights:
        print("\n[额外] 合并LoRA权重到基座模型...")
        merged_path = os.path.join(args.output, "merged")
        os.makedirs(merged_path, exist_ok=True)
        merged_model = model.merge_and_unload()
        merged_model.save_pretrained(merged_path)
        tokenizer.save_pretrained(merged_path)
        print(f"  合并模型已保存: {merged_path}")

    print("\n" + "=" * 70)
    print("训练完成！")
    print(f"LoRA适配器权重: {args.output}")
    print("\nMac MPS使用方式:")
    print(f"  1. 加载适配器: model = PeftModel.from_pretrained(base_model, '{args.output}')")
    print(f"  2. 导出GGUF: 用 llama.cpp 转换后本地部署")
    print(f"  3. 推理服务: 配置 backend/local_llm.py 中的模型路径")
    print("=" * 70)


if __name__ == "__main__":
    main()
