"""Execute the pinned upstream state machine with a deterministic browser/model port."""
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
# These are transport stubs only: all upstream model, validation and loop code runs unchanged.
for name in ('browser_harness', 'browser_harness.admin', 'browser_harness.helpers', 'httpx'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['browser_harness.admin'].ensure_daemon = lambda: None
sys.modules['browser_harness.helpers'].cdp = lambda *_args, **_kwargs: {}
sys.modules['httpx'].Client = lambda **_kwargs: None
sys.modules['httpx'].HTTPError = RuntimeError
from jev_ultrafast import agent as loop
from jev_ultrafast import model
from jev_ultrafast.browser import fingerprint, StalePage

input_data = json.load(sys.stdin)
if input_data.get('fingerprints'):
    print(json.dumps([fingerprint(page) for page in input_data['fingerprints']]))
    sys.exit(0)

class Port:
    def __init__(self):
        self.observations = iter(input_data['pages'])
        self.current = None
        self.fresh_results = iter(input_data.get('fresh', []))
        self.act_results = iter(input_data.get('acts', []))
        self.executed = []
    def observe(self, screenshot=False):
        page = next(self.observations, self.current)
        if page == 'stale':
            raise StalePage('Document changed')
        self.current = page
        return page
    def fresh(self, page, action=None):
        value = next(self.fresh_results, True)
        if value == 'stale':
            raise StalePage('Document changed')
        return value
    def act(self, action, page, text=None):
        value = next(self.act_results, None)
        if value == 'stale':
            raise StalePage('Document changed')
        self.executed.append({'id': action['id'], 'text': text})
    def close(self):
        pass

port = Port()
loop.Browser = lambda _url: port
responses = iter(input_data['policy'])
helper_requests = []
requests = []
def one(ids, selected):
    return dict(choice=selected, confidence=1, probabilities={key: int(key == selected) for key in ids})
def post(_url, _key, body):
    requests.append(body)
    if 'messages' in body:
        helper_requests.append(body)
        return {'choices': [{'message': {'content': '{"text":"book"}'}}]}
    selected = next(responses)
    answers = {'operation': one(body['questions']['operation']['criteria'], selected['operation'])}
    if 'target' in selected:
        key = selected['operation'].lower() + '_target'
        answers[key] = one(body['questions'][key]['criteria'], selected['target'])
    return {'model': 'fixture', 'answers': answers}
model.post_json = post
import os
os.environ['TYPESAFE_API_KEY'] = 'fixture'
os.environ['TYPESAFE_MODEL'] = 'fixture'
os.environ['TEXT_MODEL_API_KEY'] = 'fixture'
os.environ['TEXT_MODEL_BASE_URL'] = 'http://127.0.0.1/v1'
os.environ['TEXT_MODEL'] = 'fixture'
agent = loop.Agent('https://example.test', input_data.get('goal', 'Find a book'))
states, errors = [], []
for command in input_data['commands']:
    body = {'fingerprint': agent.state['page']['fingerprint']} if command == 'act' else {}
    try:
        agent.command(command, body)
        errors.append(None)
    except Exception as error:
        errors.append(type(error).__name__)
    states.append(agent.snapshot())
    # snapshot returns references; freeze now to compare each intermediate state.
    states[-1] = json.loads(json.dumps(states[-1]))
print(json.dumps(dict(states=states, errors=errors, executed=port.executed, requests=requests)))
