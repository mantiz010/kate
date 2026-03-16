#!/usr/bin/env python3
import sys, json
from ddgs import DDGS
query = " ".join(sys.argv[1:])
if not query:
    print(json.dumps([]))
    sys.exit(0)
try:
    results = DDGS().text(query, max_results=8)
    out = []
    for r in results:
        out.append({"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")[:200]})
    print(json.dumps(out))
except Exception as e:
    print(json.dumps([{"title":"Error","url":"","snippet":str(e)}]))
