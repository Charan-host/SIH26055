import unittest

from backend.core import (
    Hypothesis,
    Simulation,
    bayes_update,
    interval_overlap,
    run_experiments,
    score_actions,
)


class CoreTests(unittest.TestCase):
    def test_overlap(self):
        self.assertEqual(interval_overlap(20, 25, 40, 45), 0)
        self.assertEqual(interval_overlap(21, 24, 20, 25), 3)

    def test_nonoverlap_miss_is_weak(self):
        hypothesis = Hypothesis(
            'H',
            2,
            phase=20,
            width=5,
            period=100,
            posterior=0.5,
        )
        before = hypothesis.posterior

        bayes_update([hypothesis], 2, 40, 5, False, 45)

        self.assertLess(abs(hypothesis.posterior - before), 0.02)

    def test_overlap_miss_penalizes(self):
        hypothesis = Hypothesis(
            'H',
            2,
            phase=20,
            width=5,
            period=100,
            posterior=0.5,
        )

        bayes_update([hypothesis], 2, 21, 3, False, 24)

        self.assertLess(hypothesis.posterior, 0.5)

    def test_candidates_include_discovery_priority(self):
        simulation = Simulation()
        candidates = score_actions(
            simulation.hypotheses,
            simulation.last_seen,
            30,
        )

        self.assertTrue(candidates)
        self.assertGreater(candidates[0]['discovery_priority'], 0.9)

    def test_step_and_certificate(self):
        simulation = Simulation()
        state = simulation.step()

        self.assertEqual(len(state['observations']), 1)
        self.assertEqual(state['certificate']['scans_performed'], 1)

    def test_same_scenario_and_seed_reproduce_scan_history(self):
        scenario = {
            'id': 'determinism-check', 'name': 'Periodic', 'seed': 11,
            'bands': 3, 'horizon': 12, 'time_slots': 6,
            'min_dwell_ms': 1, 'max_dwell_ms': 2, 'exploration_rate': 0.2,
            'emitters': [{'id': 'E1', 'kind': 'periodic', 'band': 2, 'period': 4, 'phase': 0, 'width': 2}],
        }
        first, second = Simulation(scenario), Simulation(scenario)
        for _ in range(3):
            first_state = first.step()
            second_state = second.step()
        self.assertEqual(first_state['observations'], second_state['observations'])
        self.assertEqual(first_state['transitions'], second_state['transitions'])

    def test_paired_baselines_execute(self):
        result = run_experiments(Simulation().scenario, 1)

        self.assertEqual(len(result['methods']), 7)
        self.assertTrue(
            all('detection_rate' in method for method in result['methods'])
        )

    def test_behavior_change_recovery_is_observation_driven(self):
        simulation = Simulation()

        for _ in range(24):
            simulation.step(include_state=False)

        self.assertLessEqual(simulation.now, 100.0)
        self.assertTrue(simulation.events)
        self.assertTrue(
            any(
                event['type'] == 'BEHAVIOUR_CHANGE_DETECTED'
                for event in simulation.events
            )
        )
        self.assertGreaterEqual(simulation.certificate()['scans_performed'], 1)


if __name__ == '__main__':
    unittest.main()
