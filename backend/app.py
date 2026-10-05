"""Zero-dependency JSON API and static research console."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
import os
import json
from .core import Simulation, run_experiments, scenario_for
ROOT = Path(__file__).resolve().parents[1]
SESSION = Simulation()
SESSION_ACTIVE = False
EXPERIMENTS = {}
SCENARIOS = {}
API_EXPERIMENTS = {}
BASELINES = {}

def validate_scenario(scenario):
    if not isinstance(scenario, dict):
        raise ValueError('Scenario must be a JSON object.')
    bands = int(scenario.get('bands', 10))
    horizon = float(scenario.get('horizon', 100))
    emitters = scenario.get('emitters', [])
    if not 3 <= bands <= 40:
        raise ValueError('Number of bands must be between 3 and 40.')
    if horizon <= 0:
        raise ValueError('Simulation duration must be greater than zero.')
    if not isinstance(emitters, list) or not emitters:
        raise ValueError('Scenario must contain at least one emitter.')
    scenario['seed'] = int(scenario.get('seed', 7))
    minimum_dwell = float(scenario.get('min_dwell_ms', 2))
    maximum_dwell = float(scenario.get('max_dwell_ms', 10))
    if minimum_dwell <= 0 or maximum_dwell < minimum_dwell or maximum_dwell > horizon:
        raise ValueError('Receiver dwell limits must be positive, ordered, and fit inside the simulation duration.')
    scenario['min_dwell_ms'] = minimum_dwell
    scenario['max_dwell_ms'] = maximum_dwell
    if 'time_slots' in scenario:
        scenario['time_slots'] = int(scenario['time_slots'])
        if not 1 <= scenario['time_slots'] <= 10000:
            raise ValueError('Time slots must be between 1 and 10,000.')
    if 'initial_band' in scenario and not 1 <= int(scenario['initial_band']) <= bands:
        raise ValueError('Initial band must be within the configured frequency-band range.')
    decay = float(scenario.get('evidence_decay_rate', 0.78))
    if not 0 < decay <= 1:
        raise ValueError('Evidence decay rate must be greater than zero and no more than one.')
    exploration_rate = float(scenario.get('exploration_rate', 0.15))
    if not 0 <= exploration_rate <= 1:
        raise ValueError('Exploration rate must be between zero and one.')
    for index, emitter in enumerate(emitters):
        if not isinstance(emitter, dict) or 'kind' not in emitter:
            raise ValueError('Each emitter must include a kind.')
        emitter.setdefault('id', f'E{index + 1}')
        kind = emitter['kind']
        if kind not in ('periodic', 'duty', 'agile', 'rare', 'intermittent', 'unknown', 'behavior_change'):
            raise ValueError(f'Unsupported emitter kind: {kind}')
        if kind == 'behavior_change':
            old, new = emitter.get('old', []), emitter.get('new', [])
            if not old or not new:
                raise ValueError('Behaviour-change emitters need non-empty old and new band sequences.')
            emitter['change_time'] = float(emitter.get('change_time', horizon / 2))
            if not 0 <= emitter['change_time'] < horizon:
                raise ValueError('Behaviour-change point must fall inside the simulation duration.')
            if min(float(emitter.get('old_period', emitter.get('period', 20))), float(emitter.get('new_period', emitter.get('period', 20)))) <= 0:
                raise ValueError('Emitter periods must be greater than zero.')
            if min(float(emitter.get('old_width', emitter.get('width', 5))), float(emitter.get('new_width', emitter.get('width', 5)))) <= 0:
                raise ValueError('Emitter active durations must be greater than zero.')
            bands_to_check = old + new
        else:
            bands_to_check = emitter.get('bands', []) if kind == 'agile' else [emitter.get('band')]
            if float(emitter.get('period', 20)) <= 0 or float(emitter.get('width', 5)) <= 0:
                raise ValueError('Emitter period and active duration must be greater than zero.')
            if kind == 'agile' and not bands_to_check:
                raise ValueError('Frequency-agile emitters need at least one available band.')
        for band in bands_to_check:
            if band is not None and not 1 <= int(band) <= bands:
                raise ValueError(f'Emitter band {band} is outside the configured band range.')
    scenario['bands'] = bands
    scenario['horizon'] = horizon
    scenario.setdefault('id', f"SCN-{uuid4().hex[:8].upper()}")
    return scenario

class Handler(BaseHTTPRequestHandler):

    def log_message(self, *_args):
        return

    def send(self, status, obj, content_type='application/json; charset=utf-8'):
        if isinstance(obj, str):
            body = obj.encode('utf-8')
        else:
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get('Content-Length', 0))
        raw_body = self.rfile.read(length) if length else b'{}'
        return json.loads(raw_body)

    def do_OPTIONS(self):
        self.send(200, {})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/':
            page = (ROOT / 'frontend' / 'index.html').read_text(encoding='utf-8')
            return self.send(200, page, 'text/html; charset=utf-8')
        if path.startswith('/src/'):
            file_path = (ROOT / 'frontend' / path.lstrip('/')).resolve()
            if ROOT / 'frontend' not in file_path.parents:
                return self.send(403, {'error': 'invalid path'})
            content_type = 'text/javascript; charset=utf-8' if file_path.suffix == '.js' else 'text/plain; charset=utf-8'
            return self.send(200, file_path.read_text(encoding='utf-8'), content_type)
        if path == '/style.css':
            stylesheet = (ROOT / 'frontend' / 'style.css').read_text(encoding='utf-8')
            return self.send(200, stylesheet, 'text/css; charset=utf-8')
        if path == '/api/health':
            return self.send(200, {'status': 'ok', 'service': 'scan-graph-backend'})
        if path == '/health':
            return self.send(200, {'status': 'ok', 'service': 'scan-graph-backend', 'engine': 'Exclusion-certified scheduler'})
        if path == '/api/state':
            return self.send(200, {**SESSION.state(), 'experiment_active': SESSION_ACTIVE})
        if path.startswith('/api/experiments/'):
            parts = path.strip('/').split('/')
            if len(parts) < 3 or parts[2] not in API_EXPERIMENTS:
                return self.send(404, {'error': 'Experiment not found.'})
            simulation = API_EXPERIMENTS[parts[2]]
            state = {**simulation.state(), 'experiment_active': True, 'experiment_id': parts[2]}
            if len(parts) == 3:
                return self.send(200, state)
            if len(parts) == 4 and parts[3] == 'hypotheses':
                return self.send(200, state['hypotheses'])
            if len(parts) == 4 and parts[3] == 'evidence':
                return self.send(200, state['observations'])
            if len(parts) == 4 and parts[3] == 'certificate':
                return self.send(200, state['certificate'])
            return self.send(404, {'error': 'Experiment resource not found.'})
        if path.startswith('/api/baselines/'):
            baseline_id = path.strip('/').split('/')[-1]
            return self.send(200, BASELINES[baseline_id]) if baseline_id in BASELINES else self.send(404, {'error': 'Baseline comparison not found.'})
        if path in ('/simulation/state', '/simulation/state/'):
            state = SESSION.state()
            state['experiment_active'] = SESSION_ACTIVE
            return self.send(200, state)
        if path == '/hypotheses':
            return self.send(200, SESSION.state()['hypotheses'])
        if path == '/observations':
            return self.send(200, SESSION.observations)
        if path == '/candidate-actions':
            return self.send(200, SESSION.state()['candidates'])
        if path == '/certificate':
            return self.send(200, SESSION.certificate())
        if path == '/scenarios':
            standard_scenarios = [scenario_for(name) for name in ('Periodic', 'Intermittent', 'Duty-cycled', 'Frequency-agile', 'Rare', 'Unknown', 'Behaviour Change')]
            return self.send(200, standard_scenarios + list(SCENARIOS.values()))
        if path.startswith('/experiments/'):
            experiment_id = path.split('/')[-1]
            return self.send(200, EXPERIMENTS.get(experiment_id, {'error': 'unknown experiment'}))
        return self.send(404, {'error': 'not found'})

    def do_POST(self):
        global SESSION, SESSION_ACTIVE
        path = urlparse(self.path).path
        try:
            data = self.body()
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            return self.send(400, {'error': f'Invalid JSON request: {error}'})
        if not isinstance(data, dict):
            return self.send(400, {'error': 'Request body must be a JSON object.'})
        if path == '/api/scenarios/generate':
            try:
                scenario = validate_scenario(data.get('scenario', data))
                Simulation(scenario)
                SCENARIOS[scenario['id']] = scenario
                return self.send(201, {'status': 'generated', 'scenario': scenario, 'scenario_id': scenario['id']})
            except (TypeError, ValueError, KeyError) as error:
                return self.send(400, {'error': str(error)})
        if path == '/api/scenarios/preview':
            try:
                scenario = validate_scenario(data.get('scenario'))
                state = Simulation(scenario).state()
                return self.send(200, {'scenario': state['scenario'], 'timeline': state['timeline'], 'next_action': state['next_action'], 'hypotheses': state['hypotheses'], 'candidates': state['candidates']})
            except (TypeError, ValueError, KeyError) as error:
                return self.send(400, {'error': str(error)})
        if path == '/api/experiments/start':
            try:
                scenario = validate_scenario(data.get('scenario'))
                simulation = Simulation(scenario)
                experiment_id = f"EXP-{uuid4().hex[:10].upper()}"
                API_EXPERIMENTS[experiment_id] = simulation
                return self.send(201, {**simulation.state(), 'experiment_active': True, 'experiment_id': experiment_id})
            except (TypeError, ValueError, KeyError) as error:
                return self.send(400, {'error': str(error)})
        if path.startswith('/api/experiments/'):
            parts = path.strip('/').split('/')
            if len(parts) == 4 and parts[2] in API_EXPERIMENTS:
                simulation = API_EXPERIMENTS[parts[2]]
                if parts[3] == 'step':
                    return self.send(200, {**simulation.step(data.get('algorithm', 'proposed')), 'experiment_active': True, 'experiment_id': parts[2]})
                if parts[3] == 'reset':
                    API_EXPERIMENTS[parts[2]] = Simulation(simulation.scenario)
                    simulation = API_EXPERIMENTS[parts[2]]
                    return self.send(200, {**simulation.state(), 'experiment_active': True, 'experiment_id': parts[2]})
            return self.send(404, {'error': 'Experiment not found.'})
        if path == '/api/baselines/run':
            try:
                scenario = validate_scenario(data.get('scenario'))
                result = run_experiments(scenario, int(data.get('replicates', 6)), data.get('methods'))
                baseline_id = f"BASE-{uuid4().hex[:10].upper()}"
                result['id'] = baseline_id
                BASELINES[baseline_id] = result
                return self.send(201, result)
            except (TypeError, ValueError, KeyError) as error:
                return self.send(400, {'error': str(error)})
        if path == '/simulation/start':
            scenario = data.get('scenario') or scenario_for(data.get('name', 'Behaviour Change'), data.get('seed', 7))
            SESSION = Simulation(scenario)
            SESSION_ACTIVE = True
            state = SESSION.state()
            state['experiment_active'] = True
            return self.send(200, state)
        if path == '/simulation/reset':
            scenario = data.get('scenario') or SESSION.scenario
            SESSION = Simulation(scenario)
            SESSION_ACTIVE = True
            state = SESSION.state()
            state['experiment_active'] = True
            return self.send(200, state)
        if path == '/simulation/preview':
            simulation = Simulation(data.get('scenario'))
            state = simulation.state()
            return self.send(200, {
                'scenario': state['scenario'],
                'timeline': state['timeline'],
                'next_action': state['next_action'],
                'hypotheses': state['hypotheses'],
                'candidates': state['candidates'],
            })
        if path == '/simulation/step':
            algorithm = data.get('algorithm', 'proposed')
            state = SESSION.step(algorithm)
            state['experiment_active'] = SESSION_ACTIVE
            return self.send(200, state)
        if path == '/scenarios':
            scenario = data.get('scenario', data)
            scenario_id = scenario.get('id', scenario.get('name', 'custom'))
            SCENARIOS[scenario_id] = scenario
            return self.send(201, scenario)
        if path == '/experiments/run':
            experiment_id = f'EXP-{len(EXPERIMENTS) + 1:04d}'
            scenario = data.get('scenario') or SESSION.scenario
            replicates = int(data.get('replicates', 8))
            result = run_experiments(scenario, replicates, data.get('methods'))
            result['id'] = experiment_id
            EXPERIMENTS[experiment_id] = result
            return self.send(201, result)
        return self.send(404, {'error': 'not found'})

def main():
    host = os.environ.get('SCAN_GRAPH_HOST', '127.0.0.1')
    port = int(os.environ.get('SCAN_GRAPH_PORT', '8000'))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f'SCAN-GRAPH API and console: http://{host}:{port}', flush=True)
    server.serve_forever()
if __name__ == '__main__':
    main()
