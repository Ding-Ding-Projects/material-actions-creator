import json
import sys

request = json.loads(sys.stdin.readline())
text = request["payload"].get("input", "")
result = {
    "title": f"{len(text.split())} words",
    "items": [
        {"label": "Lines", "value": str(len(text.splitlines()))},
        {"label": "Words", "value": str(len(text.split()))},
        {"label": "Characters", "value": str(len(text))},
    ],
}
print(json.dumps({"ok": True, "result": result}))
