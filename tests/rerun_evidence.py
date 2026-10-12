import glob, json, urllib.request, os
base = os.environ.get("URL", "http://localhost:8000/api/roster")
for f in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "evidence", "*input.json"))):
    req = urllib.request.Request(base, data=open(f, "rb").read(), method="POST")
    try: r = urllib.request.urlopen(req); code = r.status; body = json.load(r)
    except urllib.error.HTTPError as e: code = e.code; body = json.load(e)
    print(os.path.basename(f), code, body["status"], body.get("value_total", ""))
