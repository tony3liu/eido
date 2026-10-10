"""Run unchanged upstream CDP guard checks against the bundled Chromium."""
import json
import sys
import types
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
for name in ('browser_harness', 'browser_harness.admin', 'browser_harness.helpers'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['browser_harness.admin'].ensure_daemon = lambda: None

def cdp(method, session_id=None, **params):
    print(json.dumps({'method': method, 'session_id': session_id, 'params': params}), flush=True)
    result = json.loads(sys.stdin.readline())
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result['result']
sys.modules['browser_harness.helpers'].cdp = cdp
import check_guards
check_guards.main()
