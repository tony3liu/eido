"""Only stub unavailable transport packages; upstream tests mock their calls."""
import sys
import types
for name in ('browser_harness', 'browser_harness.admin', 'browser_harness.helpers'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['browser_harness.admin'].ensure_daemon = lambda: None
sys.modules['browser_harness.helpers'].cdp = lambda *_args, **_kwargs: {}
