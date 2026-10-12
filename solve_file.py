"""Plan one input file without the browser:  python solve_file.py input.json output.json
Uses the same code path as POST /api/roster. Exit code 0 = ok/infeasible, 1 = invalid_input."""
import sys
import app

if len(sys.argv) != 3:
    sys.exit("usage: python solve_file.py input.json output.json")
code, out = app.roster_endpoint(open(sys.argv[1], "rb").read())
import json
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
print(out["status"], "(HTTP %d)" % code, out.get("value_total", ""), out.get("fuel_total_litres", ""))
sys.exit(0 if code == 200 else 1)
