#!/usr/bin/env python
"""
moss_bridge.py — MOSS-Transcribe-Diarize 的 Node 侧桥接

输入：音频文件路径
输出：一行 JSON 到 stdout（日志一律走 stderr，别污染结果）

    {"ok": true, "segments": [{"start": 0.48, "end": 1.66, "speaker": "S01", "text": "..."}]}

为什么走子进程而不是常驻服务：模型加载要几秒到几十秒，但一集只跑一次，
常驻服务多一个进程要管、多一个端口要占，不值。和 dsh-video-storyboard 的
ocr_bridge.py 是同一个思路（一次 subprocess 换 JSON）。

用法：
    python moss_bridge.py <audio.wav> [--max-new-tokens 65536] [--model OpenMOSS-Team/MOSS-Transcribe-Diarize]
"""
import argparse
import json
import sys
import time


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="音频文件路径（wav/mp3/flac 等，内部按 16kHz 处理）")
    parser.add_argument("--model", default="OpenMOSS-Team/MOSS-Transcribe-Diarize")
    parser.add_argument("--max-new-tokens", type=int, default=65536)
    parser.add_argument("--attn", default=None, help="sdpa / flash_attention_2 / eager，默认自动挑")
    args = parser.parse_args()

    started = time.time()
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            generate_transcription,
            resolve_device,
        )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"依赖缺失: {exc}"}, ensure_ascii=False))
        return 1

    try:
        device = resolve_device("auto")
        dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
        log(f"[moss] device={device} dtype={dtype}")

        load_started = time.time()
        model = AutoModelForCausalLM.from_pretrained(
            args.model,
            trust_remote_code=True,
            dtype="auto",
            attn_implementation=args.attn or "sdpa",
        ).to(dtype=dtype).to(device).eval()
        processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True)
        log(f"[moss] 模型加载 {time.time() - load_started:.1f}s")

        messages = build_transcription_messages(args.audio)
        infer_started = time.time()
        result = generate_transcription(
            model,
            processor,
            messages,
            max_new_tokens=args.max_new_tokens,
            do_sample=False,
            device=device,
            dtype=dtype,
        )
        log(f"[moss] 推理 {time.time() - infer_started:.1f}s")

        segments = []
        for seg in parse_transcript(result["text"]):
            segments.append({
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "speaker": str(seg.speaker),
                "text": str(seg.text).strip(),
            })

        print(json.dumps({
            "ok": True,
            "segments": segments,
            "raw": result["text"],
            "elapsed": round(time.time() - started, 1),
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
