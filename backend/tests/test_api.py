import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend import app


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def call(self, method, path, payload=None, origin=None):
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        return response.status, response.headers, json.loads(response.read().decode())

    def scenario(self):
        return {
            'id': 'API-TEST-SCENARIO', 'name': 'Periodic', 'seed': 3,
            'bands': 3, 'horizon': 8, 'min_dwell_ms': 1, 'max_dwell_ms': 2,
            'receiver_bandwidth_bands': 1,
            'emitters': [{'id': 'E1', 'kind': 'periodic', 'band': 2, 'period': 4, 'phase': 0, 'width': 2}],
        }

    def test_health_and_cors(self):
        status, headers, body = self.call('GET', '/api/health', origin='http://localhost:5500')
        self.assertEqual(status, 200)
        self.assertEqual(body, {'status': 'ok', 'service': 'scan-graph-backend'})
        self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
        status, headers, _ = self.call('OPTIONS', '/api/experiments/start', origin='http://localhost:5500')
        self.assertEqual(status, 200)
        self.assertIn('POST', headers['Access-Control-Allow-Methods'])

    def test_scenario_validation(self):
        status, _, result = self.call('POST', '/api/scenarios/generate', {'scenario': self.scenario()})
        self.assertEqual(status, 201)
        self.assertEqual(result['scenario']['bands'], 3)
        status, _, error = self.call('POST', '/api/scenarios/generate', {'scenario': {'bands': 0}})
        self.assertEqual(status, 400)
        self.assertIn('bands', error['error'])

    def test_experiment_steps_and_evidence_resources(self):
        status, _, state = self.call('POST', '/api/experiments/start', {'scenario': self.scenario()})
        self.assertEqual(status, 201)
        experiment_id = state['experiment_id']
        status, _, stepped = self.call('POST', f'/api/experiments/{experiment_id}/step', {})
        self.assertEqual(status, 200)
        self.assertEqual(len(stepped['observations']), 1)
        for resource in ('', '/hypotheses', '/evidence', '/certificate'):
            status, _, data = self.call('GET', f'/api/experiments/{experiment_id}{resource}')
            self.assertEqual(status, 200)
            self.assertTrue(data)
        status, _, reset = self.call('POST', f'/api/experiments/{experiment_id}/reset', {})
        self.assertEqual(status, 200)
        self.assertEqual(reset['observations'], [])

    def test_baseline_comparison_is_saved_and_readable(self):
        status, _, result = self.call('POST', '/api/baselines/run', {
            'scenario': self.scenario(), 'replicates': 1, 'methods': ['sequential'],
        })
        self.assertEqual(status, 201)
        self.assertEqual(result['methods'][0]['algorithm'], 'sequential')
        status, _, saved = self.call('GET', f"/api/baselines/{result['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(saved['seed'], 3)


if __name__ == '__main__':
    unittest.main()
