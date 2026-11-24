# LoRA 微调指南

该项目使用 `scripts/lora_train.py` 对 Qwen2.5-1.5B-Instruct 进行 LoRA 微调。训练依赖与在线服务依赖分开维护，云 GPU 环境只需安装训练依赖。

## 训练

```bash
pip install -r requirements-train.txt
python scripts/lora_train.py \
  --model Qwen/Qwen2.5-1.5B-Instruct \
  --output models/lora-interview \
  --epochs 3 \
  --batch-size 2 \
  --merge-weights
```

有 CUDA GPU 时脚本会自动选择 CUDA；Apple Silicon 可使用 MPS。显存不足时可降低 batch size 或 LoRA 秩。首次运行需要从模型仓库下载基础模型。

## 部署训练结果

合并后的模型默认位于 `models/lora-interview/merged/`。后端启动时会尝试加载该目录。模型文件和训练检查点体积较大，仓库通过 `.gitignore` 排除；请单独保存并部署到目标机器。

当前 `backend/local_llm.py` 预留了本地推理服务代码，常规 API 面试流程直接在 FastAPI 中加载合并后的 Transformers 模型。
