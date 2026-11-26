"""
The only place that talks to the language model.

Right now we use Groq (free tier, open-source models).
To switch to Claude later, only this file changes: agent.py and tools.py stay the same.
"""

import os

import requests

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")


def ask_llm(messages: list[dict], tools: list[dict]) -> dict:
    """
    Sends the conversation so far and the available tools to the model.
    Returns the model's reply: either plain text or a request to call a tool.
    """
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY is not set (add it to GitHub Secrets).")

    response = requests.post(
        GROQ_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": MODEL,
            "messages": messages,
            "temperature": 0.3,
            **({"tools": tools, "tool_choice": "auto"} if tools else {}),  # no tools → the model must answer in text
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]
