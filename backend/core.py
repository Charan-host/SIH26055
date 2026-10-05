"""Reproducible, ground-truth-isolated spectrum scheduling prototype."""
from __future__ import annotations
import hashlib
import json
import math
import random
import time
import tracemalloc
from collections import Counter
from dataclasses import dataclass, field, asdict
DWELLS = (2.0, 4.0, 6.0, 8.0, 10.0)

def interval_overlap(a: float, b: float, c: float, d: float) -> float:
    return max(0.0, min(b, d) - max(a, c))

def activity_intervals(emitter: dict, start: float, end: float) -> list[tuple[float, float]]:
    """True activity intervals intersecting a requested time range."""
    kind = emitter['kind']
    out = []
    if kind in ('intermittent', 'unknown', 'rare'):
        width = emitter.get('width', 4.0)
        step = emitter.get('period', 20.0)
        k0 = max(0, int((start - width) / step))
        k1 = int(end / step) + 1
        for k in range(k0, k1 + 1):
            token = int.from_bytes(hashlib.sha256(f"{emitter.get('seed', 0)}:{emitter['id']}:{k}".encode()).digest()[:4], 'big') / 4294967295
            if token < emitter.get('probability', 0.3):
                out.append((k * step + emitter.get('phase', 0), k * step + emitter.get('phase', 0) + width))
    elif kind == 'behavior_change':
        change = emitter['change_time']
        old = emitter['old']
        new = emitter['new']
        segments = [
            (0.0, change, old, emitter.get('old_period', emitter.get('period', 20.0)), emitter.get('old_width', emitter.get('width', 5.0))),
            (change, float('inf'), new, emitter.get('new_period', emitter.get('period', 20.0)), emitter.get('new_width', emitter.get('width', 5.0))),
        ]
        for lo, hi, _bands, step, width in segments:
            first = max(0, int((start - lo - width) / step))
            last = int((end - lo) / step) + 1
            for k in range(first, last + 1):
                t0 = lo + k * step
                if t0 < hi and t0 <= end and t0 + width > start:
                    out.append((t0, min(t0 + width, hi)))
    elif kind == 'agile':
        step = emitter.get('period', 20.0)
        for k in range(max(0, int(start / step) - 1), int(end / step) + 2):
            t = k * step + emitter.get('phase', 0.0)
            out.append((t, t + emitter.get('width', 5.0)))
    else:
        step = emitter.get('period', 20.0)
        phase = emitter.get('phase', 0.0)
        width = emitter.get('width', 5.0)
        for k in range(max(0, int((start - phase - width) / step)), int((end - phase) / step) + 2):
            t = phase + k * step
            out.append((t, t + width))
    return [(max(start, a), min(end, b)) for a, b in out if min(end, b) > max(start, a)]

def emitter_band(emitter: dict, t: float) -> int:
    kind = emitter['kind']
    if kind == 'behavior_change':
        if t < emitter['change_time']:
            seq = emitter['old']
            period = emitter.get('old_period', emitter.get('period', 20.0))
            elapsed = max(0.0, t)
        else:
            seq = emitter['new']
            period = emitter.get('new_period', emitter.get('period', 20.0))
            elapsed = max(0.0, t - emitter['change_time'])
        return seq[int(elapsed // period) % len(seq)]
    if kind == 'agile':
        bands = emitter.get('bands', [2, 4, 7])
        hop = int(max(0, t - emitter.get('phase', 0)) // emitter.get('period', 20.0))
        if emitter.get('hop_pattern') == 'random' and hop > 0:
            token = hashlib.sha256(f"{emitter.get('seed', 0)}:{hop}".encode()).digest()
            return bands[int.from_bytes(token[:4], 'big') % len(bands)]
        return bands[hop % len(bands)]
    return emitter.get('band', 2)

def default_scenario(name='Behaviour Change', seed=7):
    return {
        'id': 'SCN-BC-01',
        'name': name,
        'seed': seed,
        'horizon': 100.0,
        'bands': 10,
        'receiver_bandwidth_mhz': 10.0,
        'emitters': [
            {
                'id': 'E1',
                'kind': 'behavior_change',
                'old': [2, 6, 9],
                'new': [2, 4, 8],
                'change_time': 40.0,
                'period': 12.0,
                'width': 5.0,
                'label': 'Agile transmitter',
            },
            {
                'id': 'E2',
                'kind': 'rare',
                'band': 8,
                'period': 20.0,
                'phase': 3.0,
                'width': 3.0,
                'probability': 0.12,
                'label': 'Rare beacon',
            },
        ],
    }

def scenario_for(name, seed=7):
    if name.lower().startswith('behav'):
        return default_scenario(name, seed)
    kinds = {'periodic': 'periodic', 'intermittent': 'intermittent', 'duty-cycled': 'duty', 'frequency-agile': 'agile', 'rare': 'rare', 'unknown': 'unknown'}
    key = next((k for k in kinds if k in name.lower()), 'periodic')
    kind = kinds[key]
    em = {'id': 'E1', 'kind': kind, 'band': 6, 'period': 20.0, 'phase': 4.0, 'width': 5.0, 'probability': 0.3, 'label': name}
    if kind == 'agile':
        em['bands'] = [2, 4, 7]
    return {'id': 'SCN-' + key.upper(), 'name': name, 'seed': seed, 'horizon': 100.0, 'bands': 10, 'receiver_bandwidth_mhz': 10.0, 'emitters': [em]}

@dataclass
class Hypothesis:
    id: str
    band: int
    kind: str = 'periodic'
    period: float = 20.0
    phase: float = 4.0
    width: float = 5.0
    prior: float = 0.1
    posterior: float = 0.1
    confidence: float = 0.1
    last_supported: float | None = None
    last_contradicted: float | None = None
    stale: float = 0.0
    history: list = field(default_factory=list)
    supports: list = field(default_factory=list)
    contradictions: list = field(default_factory=list)
    evidence: list = field(default_factory=list)

def likelihood(h: Hypothesis, band: int, start: float, dwell: float, hit: bool) -> tuple[float, float]:
    temporal = 0.0
    k0 = max(0, int((start - h.phase - h.width) / h.period))
    k1 = int((start + dwell - h.phase) / h.period) + 2
    for k in range(k0, k1 + 1):
        temporal = max(temporal, interval_overlap(start, start + dwell, h.phase + k * h.period, h.phase + k * h.period + h.width) / max(dwell, 1e-09))
    overlap = temporal if h.band == band else 0.0
    p_hit = 0.03 + 0.92 * overlap
    return (p_hit if hit else 1 - p_hit, overlap)

def bayes_update(hypotheses: list[Hypothesis], band: int, start: float, dwell: float, hit: bool, now: float):
    rows = []
    for h in hypotheses:
        lh, ov = likelihood(h, band, start, dwell, hit)
        prior = h.posterior
        rows.append((h, prior, lh, ov))
    for h, prior, lh, ov in rows:
        baseline = 0.03 if hit else 0.97
        post = prior * lh / (prior * lh + (1 - prior) * baseline) if prior * lh + (1 - prior) * baseline > 0 else prior
        h.posterior = post
        h.confidence = h.posterior
        evidence = {
            'time': now,
            'band': band,
            'start': start,
            'end': start + dwell,
            'observation': 'HIT' if hit else 'MISS',
            'prior': round(prior, 6),
            'likelihood': round(lh, 6),
            'posterior': round(post, 6),
            'overlap': round(ov, 6),
            'reason': (
                'Supported by an overlapping detection'
                if hit and h.band == band and ov > 0.1
                else 'Contradicted by a detectable activity window'
                if not hit and h.band == band and ov > 0.4
                else 'Not penalized because the hypothesis was not observable'
                if not hit and ov < 0.1
                else 'Observation supplied little evidence'
            ),
        }
        h.evidence.append(evidence)
        if hit and h.band == band and (ov > 0.1):
            h.last_supported = now
            h.stale = 0.0
            h.supports.append({'time': now, 'band': band, 'overlap': ov})
        elif not hit and h.band == band and (ov > 0.4):
            h.last_contradicted = now
            h.stale = min(1.0, h.stale + 0.08)
            h.contradictions.append(evidence)
        h.history.append({'time': now, 'posterior': h.posterior})
    return [
        {
            'id': h.id,
            'band': h.band,
            'prior': round(p, 6),
            'likelihood': round(l, 6),
            'posterior': round(h.posterior, 6),
            'overlap': round(o, 6),
            'change': round(h.posterior - p, 6),
        }
        for h, p, l, o in rows
    ]

def initialize_hypotheses(band_count=10):
    hypotheses = []
    for band in range(1, band_count + 1):
        for period, prior in ((12.0, 0.055), (20.0, 0.055), (30.0, 0.04)):
            phase = (band * 3.0) % period
            hypotheses.append(
                Hypothesis(
                    f'H{band}-P{int(period)}',
                    band,
                    period=period,
                    phase=phase,
                    prior=prior,
                    posterior=prior,
                    confidence=prior,
                    history=[{'time': 0.0, 'posterior': prior}],
                )
            )

    if band_count >= 8:
        hypotheses.append(
            Hypothesis(
                'H8-RARE',
                8,
                kind='rare',
                period=20.0,
                phase=3.0,
                width=3.0,
                prior=0.04,
                posterior=0.04,
                confidence=0.04,
                history=[{'time': 0.0, 'posterior': 0.04}],
            )
        )
    return hypotheses

def _entropy(probabilities):
    return -sum(p * math.log(p) for p in probabilities if p > 1e-12)

def dwell_options(min_dwell=2.0, max_dwell=10.0):
    values = [float(value) for value in range(math.ceil(min_dwell), math.floor(max_dwell) + 1, 2)]
    if not values:
        values = [float(min_dwell)]
    if float(max_dwell) not in values:
        values.append(float(max_dwell))
    return values


def candidate_start_times(now, horizon, time_slots=None):
    if time_slots is not None and int(time_slots) > 0:
        slot_width = horizon / int(time_slots)
        first = math.ceil((now - 1e-9) / max(slot_width, 1e-9))
        return [round(index * slot_width, 1) for index in range(first, min(int(time_slots), first + 5))]
    return [now + offset for offset in (0, 2, 4, 6, 8)]


def score_actions(hypotheses, last_seen, now, deadline=24.0, weights=None, last_actions=None, horizon=100.0, band_count=10, min_dwell=2.0, max_dwell=10.0, time_slots=None):
    """Score each band/start/dwell using posterior-predictive information gain."""
    objective_weights = {
        'information': 0.30,
        'overlap': 0.12,
        'uncertainty': 0.10,
        'exclusion': 0.22,
        'discovery': 0.18,
        'rare': 0.10,
        'cost': 0.08,
        'redundancy': 0.12,
        'wait': 0.025,
    }
    weight_aliases = {
        'info': 'information',
        'elimination': 'exclusion',
    }
    for name, value in (weights or {}).items():
        objective_weights[weight_aliases.get(name, name)] = value
    actions = []
    posterior_total = sum(max(h.posterior, 0.0) for h in hypotheses) or 1.0
    prior = [max(h.posterior, 0.0) / posterior_total for h in hypotheses]
    entropy_before = _entropy(prior)
    entropy_scale = max(math.log(max(2, len(hypotheses))), 1e-12)
    action_history = last_actions or []

    dwell_values = dwell_options(min_dwell, max_dwell)

    for band in range(1, band_count + 1):
        last_observed = last_seen.get(band, -1.0)
        age = max(0.0, now - last_observed) if last_observed >= 0 else now
        discovery_risk = min(1.0, age / max(deadline, 1e-9))
        recent_band_scans = sum(action['band'] == band for action in action_history[-8:])

        for start in candidate_start_times(now, horizon, time_slots):
            for dwell in dwell_values:
                if start + dwell > horizon:
                    continue

                overlaps = []
                hit_probabilities = []
                rare_mass = 0.0
                for hypothesis, prior_mass in zip(hypotheses, prior):
                    hit_likelihood, overlap = likelihood(
                        hypothesis,
                        band,
                        start,
                        dwell,
                        True,
                    )
                    overlaps.append(overlap)
                    hit_probabilities.append(hit_likelihood)
                    if hypothesis.kind == 'rare':
                        rare_mass += prior_mass * overlap

                hit_probability = sum(
                    mass * likelihood_value
                    for mass, likelihood_value in zip(prior, hit_probabilities)
                )
                miss_probability = 1.0 - hit_probability
                expected_entropy = 0.0

                for outcome_probability, outcome_likelihoods in (
                    (hit_probability, hit_probabilities),
                    (miss_probability, [1.0 - p for p in hit_probabilities]),
                ):
                    if outcome_probability <= 1e-12:
                        continue
                    posterior_after = [
                        mass * likelihood_value / outcome_probability
                        for mass, likelihood_value in zip(prior, outcome_likelihoods)
                    ]
                    expected_entropy += outcome_probability * _entropy(posterior_after)

                information_gain = max(
                    0.0,
                    min(1.0, (entropy_before - expected_entropy) / entropy_scale),
                )
                expected_overlap = sum(
                    mass * overlap for mass, overlap in zip(prior, overlaps)
                )
                uncertainty = sum(
                    mass * 4.0 * hypothesis.posterior * (1.0 - hypothesis.posterior) * overlap
                    for hypothesis, mass, overlap in zip(hypotheses, prior, overlaps)
                )
                exclusion_gain = sum(
                    mass * overlap * (1.0 - hypothesis.posterior)
                    for hypothesis, mass, overlap in zip(hypotheses, prior, overlaps)
                )
                miss_after = [
                    mass * (1.0 - p) / max(miss_probability, 1e-12)
                    for mass, p in zip(prior, hit_probabilities)
                ]
                eliminated_mass = sum(
                    max(0.0, before - after) * overlap
                    for before, after, overlap in zip(prior, miss_after, overlaps)
                )
                exclusion_gain = min(1.0, (exclusion_gain + eliminated_mass) / 2.0)

                same_action_count = sum(
                    action['band'] == band
                    and abs(action['start'] - start) < 4.0
                    and abs(action['dwell'] - dwell) < 2.0
                    for action in action_history[-8:]
                )
                redundancy = min(1.0, same_action_count / 2.0 + recent_band_scans / 12.0)
                scan_cost = dwell / 10.0
                wait_cost = (start - now) / 8.0
                rare_priority = min(1.0, rare_mass * 8.0 + discovery_risk * 0.15)

                positive = (
                    objective_weights['information'] * information_gain
                    + objective_weights['overlap'] * expected_overlap
                    + objective_weights['uncertainty'] * min(1.0, uncertainty)
                    + objective_weights['exclusion'] * exclusion_gain
                    + objective_weights['discovery'] * discovery_risk
                    + objective_weights['rare'] * rare_priority
                )
                penalties = (
                    objective_weights['cost'] * scan_cost
                    + objective_weights['redundancy'] * redundancy
                    + objective_weights['wait'] * wait_cost
                )
                utility = positive - penalties

                if discovery_risk >= 0.75:
                    reason = 'Discovery deadline is near'
                elif rare_priority > 0.25:
                    reason = 'Rare-emitter and temporal-overlap opportunity'
                elif information_gain > 0.01:
                    reason = 'Expected posterior uncertainty reduction'
                elif expected_overlap > 0.05:
                    reason = 'Observable hypothesis exclusion opportunity'
                else:
                    reason = 'Explore a band with limited recent evidence'

                actions.append(
                    {
                        'band': band,
                        'start': round(start, 1),
                        'dwell': dwell,
                        # Stable sub-nanounit tie-breaker keeps distinct actions
                        # distinguishable without changing the objective ranking.
                        'score': round(utility + band * 1e-9 + start * 1e-11 + dwell * 1e-13, 12),
                        'information_gain': round(information_gain, 6),
                        'expected_overlap': round(expected_overlap, 6),
                        'uncertainty': round(min(1.0, uncertainty), 6),
                        'elimination_gain': round(exclusion_gain, 6),
                        'discovery_priority': round(discovery_risk, 6),
                        'rare_priority': round(rare_priority, 6),
                        'redundancy_penalty': round(redundancy, 6),
                        'scan_cost': round(scan_cost, 6),
                        'wait_cost': round(wait_cost, 6),
                        'reason': reason,
                    }
                )

    return sorted(actions, key=lambda action: (-action['score'], action['start'], action['dwell'], action['band']))

def scan_ground_truth(scenario, action, rng):
    start = action['start']
    end = start + action['dwell']
    active = []
    intervals = []
    for e in scenario['emitters']:
        iv = [(a, b) for a, b in activity_intervals(e, start, end) if emitter_band(e, (a + b) / 2) == action['band']]
        ov = sum((interval_overlap(start, end, a, b) for a, b in iv))
        detection_probability = min(1.0, 0.75 + 0.25 * ov / action['dwell'])
        detection_probability *= max(0.0, 1.0 - float(scenario.get('noise_level', 0.0)))
        if ov > 0 and rng.random() < detection_probability:
            active.append(e['id'])
            intervals += [{'emitter': e['id'], 'start': a, 'end': b} for a, b in iv]
    hit = bool(active)
    false_alarm = False
    if not hit and rng.random() < float(scenario.get('false_alarm_probability', 0.0)):
        hit = True
        false_alarm = True
    overlap = sum(
        interval_overlap(start, end, interval['start'], interval['end'])
        for interval in intervals
    )
    confidence = min(1.0, 0.75 + overlap / max(action['dwell'], 1) * 0.25)
    noise = float(scenario.get('noise_level', 0.0))
    confidence *= max(0.0, 1.0 - noise)
    return {
        'band': action['band'],
        'start': start,
        'end': end,
        'dwell': action['dwell'],
        'hit': hit,
        'false_alarm': false_alarm,
        'observation': 'HIT' if hit else 'MISS',
        'active_emitters': active,
        'activity_intervals': intervals,
        'overlap': overlap,
        'signal_strength': round(min(1.0, overlap / max(action['dwell'], 1e-9)) * max(0.0, 1.0 - noise), 3),
        'detection_confidence': round(confidence, 3) if hit and not false_alarm else 0.0,
    }


def build_timeline(scenario, hypotheses, horizon):
    """Build separate truth and model tracks for the receiver console."""
    truth_windows = []
    change_points = []

    for emitter in scenario['emitters']:
        for start, end in activity_intervals(emitter, 0.0, horizon):
            band = emitter_band(emitter, (start + end) / 2)
            truth_windows.append(
                {
                    'band': band,
                    'start': start,
                    'end': end,
                    'emitter': emitter['id'],
                    'label': emitter.get('label', emitter['id']),
                }
            )
        if emitter['kind'] == 'behavior_change':
            change_points.append(
                {
                    'time': emitter['change_time'],
                    'from': emitter['old'],
                    'to': emitter['new'],
                    'type': 'configured_ground_truth_change',
                }
            )

    predicted_windows = []
    best_by_band = {}
    for hypothesis in hypotheses:
        current = best_by_band.get(hypothesis.band)
        if current is None or hypothesis.posterior > current.posterior:
            best_by_band[hypothesis.band] = hypothesis

    for band, hypothesis in best_by_band.items():
        first = int((0.0 - hypothesis.phase - hypothesis.width) / hypothesis.period)
        last = int(horizon / hypothesis.period) + 2
        for cycle in range(max(0, first), last):
            start = hypothesis.phase + cycle * hypothesis.period
            end = start + hypothesis.width
            if end <= 0 or start >= horizon:
                continue
            predicted_windows.append(
                {
                    'band': band,
                    'start': max(0.0, start),
                    'end': min(horizon, end),
                    'hypothesis': hypothesis.id,
                    'posterior': hypothesis.posterior,
                }
            )

    return {
        'horizon': horizon,
        'truth_windows': truth_windows,
        'predicted_windows': predicted_windows,
        'change_points': change_points,
    }

class Simulation:

    def __init__(self, scenario=None):
        self.scenario = scenario or default_scenario()
        self.rng = random.Random(self.scenario['seed'])
        self.observation_seed = int(self.scenario['seed'])
        self.band_count = int(self.scenario.get('bands', 10))
        self.hypotheses = initialize_hypotheses(self.band_count)
        self.observations = []
        self.actions = []
        self.now = 0.0
        self.last_seen = {b: -1.0 for b in range(1, self.band_count + 1)}
        self.mode = 'EXPLORATION'
        self.events = []
        self.change_detected = False
        self.recovery_until = -1.0
        self.hit_band_sequence = []
        self.transition_counts = Counter()
        self.discovery_deadline = float(self.scenario.get('discovery_deadline', 24.0))
        self.scheduling_weights = self.scenario.get('scheduling_weights')

    def effective_weights(self):
        active_weights = dict(self.scheduling_weights or {})
        if self.now < self.recovery_until:
            active_weights['discovery'] = active_weights.get('discovery', 0.18) * 1.6
            active_weights['rare'] = active_weights.get('rare', 0.10) * 1.4
        return active_weights

    def state(self):
        candidates = score_actions(
            self.hypotheses,
            self.last_seen,
            self.now,
            self.discovery_deadline,
            weights=self.effective_weights(),
            last_actions=self.actions,
            horizon=self.scenario.get('horizon', 100.0),
            band_count=self.band_count,
            min_dwell=float(self.scenario.get('min_dwell_ms', 2.0)),
            max_dwell=float(self.scenario.get('max_dwell_ms', 10.0)),
            time_slots=self.scenario.get('time_slots'),
        )
        discovery = []
        for band in range(1, self.band_count + 1):
            last_seen = self.last_seen[band]
            age = max(0, self.now - last_seen) if last_seen >= 0 else self.now
            discovery.append(
                {
                    'band': band,
                    'last_meaningful_observation': last_seen if last_seen >= 0 else None,
                    'age': round(age, 1),
                    'risk': round(min(1, max(0, age / self.discovery_deadline)), 2),
                }
            )

        next_action = candidates[0] if candidates else None
        last_observation = self.observations[-1] if self.observations else None
        if last_observation is None:
            reasoning = {
                'observation': 'Waiting for first receiver scan',
                'temporal_overlap': None,
                'likelihood': None,
                'posterior_before': None,
                'posterior_after': None,
                'exclusion_gain': None,
                'discovery_check': discovery,
                'next_action': next_action,
            }
        else:
            reasoning = dict(last_observation['reasoning'])
            reasoning['discovery_check'] = next(
                item for item in discovery if item['band'] == last_observation['band']
            )
            reasoning['next_action'] = next_action

        return {
            'scenario': self.scenario,
            'time': self.now,
            'receiver_bandwidth_mhz': self.scenario.get('receiver_bandwidth_mhz', 10),
            'receiver_bandwidth_bands': self.scenario.get('receiver_bandwidth_bands', 1),
            'exploration_ratio': round(sum(action.get('mode') == 'EXPLORATION' for action in self.actions) / max(1, len(self.actions)), 3),
            'graph_confidence': round(1.0 - math.exp(-sum(self.transition_counts.values()) / 8.0), 3),
            'observations': self.observations,
            'hypotheses': [asdict(hypothesis) for hypothesis in self.hypotheses],
            'candidates': candidates[:8],
            'mode': self.mode,
            'events': self.events,
            'discovery': discovery,
            'timeline': build_timeline(
                self.scenario,
                self.hypotheses,
                self.scenario.get('horizon', 100.0),
            ),
            'next_action': next_action,
            'reasoning': reasoning,
            'transitions': [
                {'from': source, 'to': target, 'count': count}
                for (source, target), count in self.transition_counts.items()
            ],
            'recovery_until': self.recovery_until,
            'certificate': self.certificate(),
        }

    def step(self, algorithm='proposed', include_state=True):
        return execute_scan_step(self, algorithm, include_state)

    def certificate(self):
        excluded = []
        weakened = []
        for hypothesis in self.hypotheses:
            negative_evidence = [
                item for item in hypothesis.evidence
                if item['observation'] == 'MISS' and item['overlap'] >= 0.1
            ]
            if hypothesis.posterior < 0.025 and negative_evidence:
                excluded.append(
                    {
                        'id': hypothesis.id,
                        'band': hypothesis.band,
                        'posterior': round(hypothesis.posterior, 6),
                        'reason': negative_evidence[-1]['reason'],
                        'evidence': negative_evidence,
                    }
                )
            elif negative_evidence:
                weakened.append(
                    {
                        'id': hypothesis.id,
                        'band': hypothesis.band,
                        'posterior': round(hypothesis.posterior, 6),
                        'evidence': negative_evidence,
                    }
                )

        plausible = [
            {
                'id': hypothesis.id,
                'band': hypothesis.band,
                'posterior': round(hypothesis.posterior, 6),
            }
            for hypothesis in self.hypotheses
            if hypothesis.posterior >= 0.025
        ]
        non_informative = [
            {
                'observation_index': observation['index'],
                'band': observation['band'],
                'start': observation['start'],
                'end': observation['end'],
                'unaffected_hypotheses': observation['unaffected_hypotheses'],
            }
            for observation in self.observations
            if observation['observation'] == 'MISS'
            and observation['unaffected_hypotheses']
        ]
        informative_count = sum(observation['informative'] for observation in self.observations)

        return {
            'scenario_id': self.scenario['id'],
            'time_window': [0, self.now],
            'scans_performed': len(self.observations),
            'scans': self.observations,
            'hypotheses_considered': len(self.hypotheses),
            'excluded_hypotheses': excluded,
            'weakened_hypotheses': weakened,
            'remaining_plausible': plausible,
            'unaffected_by_misses': non_informative,
            'behaviour_change_events': self.events,
            'learned_transitions': [
                {'from': source, 'to': target, 'count': count}
                for (source, target), count in self.transition_counts.items()
            ],
            'discovery_status': self.discovery(),
            'confidence': round(1.0 - math.exp(-informative_count / 8.0), 3),
            'scheduler_decisions': self.actions,
        }

    def discovery(self):
        return [{'band': b, 'last_meaningful_observation': self.last_seen[b] if self.last_seen[b] >= 0 else None, 'risk': round(min(1, max(0, (max(0, self.now - self.last_seen[b]) if self.last_seen[b] >= 0 else self.now) / self.discovery_deadline)), 2)} for b in range(1, self.band_count + 1)]

def execute_scan_step(simulation, algorithm='proposed', include_state=True):
    if simulation.now >= simulation.scenario.get('horizon', 100):
        return simulation.state()

    horizon = simulation.scenario.get('horizon', 100.0)
    if algorithm == 'proposed':
        actions = score_actions(
            simulation.hypotheses,
            simulation.last_seen,
            simulation.now,
            simulation.discovery_deadline,
            weights=simulation.effective_weights(),
            last_actions=simulation.actions,
            horizon=horizon,
            band_count=simulation.band_count,
            min_dwell=float(simulation.scenario.get('min_dwell_ms', 2.0)),
            max_dwell=float(simulation.scenario.get('max_dwell_ms', 10.0)),
            time_slots=simulation.scenario.get('time_slots'),
        )
        action = actions[0]
        exploration_rate = min(1.0, max(0.0, float(simulation.scenario.get('exploration_rate', 0.0))))
        if simulation.mode != 'EXPLOITATION' and exploration_rate and simulation.rng.random() < exploration_rate:
            action = max(
                actions,
                key=lambda item: (
                    item['discovery_priority'],
                    -sum(previous.get('band') == item['band'] for previous in simulation.actions[-8:]),
                    item['score'],
                ),
            )
    else:
        actions = [
            {'band': band, 'start': round(start, 1), 'dwell': dwell}
            for band in range(1, simulation.band_count + 1)
            for start in candidate_start_times(simulation.now, horizon, simulation.scenario.get('time_slots'))
            for dwell in dwell_options(
                float(simulation.scenario.get('min_dwell_ms', 2.0)),
                float(simulation.scenario.get('max_dwell_ms', 10.0)),
            )
            if start + dwell <= horizon
        ]
        if algorithm == 'random':
            action = simulation.rng.choice(actions)
        elif algorithm == 'sequential':
            target_band = len(simulation.observations) % simulation.band_count + 1
            action = next((item for item in actions if item['band'] == target_band), actions[0])
        elif algorithm == 'fixed_priority':
            priority = [2, 4, 6, 8, 1, 3, 5, 7, 9]
            priority.extend(band for band in range(1, simulation.band_count + 1) if band not in priority)
            rank = {band: index for index, band in enumerate(priority)}
            action = min(actions, key=lambda item: (rank.get(item['band'], item['band']), item['start'], item['dwell']))
        elif algorithm == 'greedy':
            action = max(
                actions,
                key=lambda item: (
                    sum(h.posterior for h in simulation.hypotheses if h.band == item['band']),
                    -item['dwell'],
                ),
            )
        elif algorithm == 'ucb':
            action = max(
                actions,
                key=lambda item: sum(
                    h.posterior for h in simulation.hypotheses if h.band == item['band']
                ) + math.sqrt(
                    2 * math.log(len(simulation.observations) + 2)
                    / (1 + sum(o['band'] == item['band'] for o in simulation.observations))
                ),
            )
        elif algorithm == 'thompson':
            action = max(
                actions,
                key=lambda item: simulation.rng.betavariate(
                    1 + sum(o['band'] == item['band'] and o['hit'] for o in simulation.observations),
                    1 + sum(o['band'] == item['band'] and not o['hit'] for o in simulation.observations),
                ),
            )
        else:
            raise ValueError(f'Unknown scheduling algorithm: {algorithm}')

    action = dict(action)
    action['start'] = round(max(simulation.now, action['start']), 1)
    prior_time = simulation.now
    noise_key = (
        f"{simulation.observation_seed}:{action['band']}:"
        f"{action['start']:.1f}:{action['dwell']:.1f}"
    )
    noise_seed = int.from_bytes(hashlib.sha256(noise_key.encode()).digest()[:8], 'big')
    observation_rng = random.Random(noise_seed)
    observation = scan_ground_truth(simulation.scenario, action, observation_rng)
    simulation.now = observation['end']

    prior_total = sum(h.posterior for h in simulation.hypotheses) or 1.0
    predictive_likelihood = sum(
        h.posterior * likelihood(
            h,
            observation['band'],
            observation['start'],
            observation['dwell'],
            True,
        )[0]
        for h in simulation.hypotheses
    ) / prior_total
    previous_hit_band = simulation.hit_band_sequence[-1] if simulation.hit_band_sequence else None
    previous_confidence = max(
        (h.posterior for h in simulation.hypotheses if h.band == previous_hit_band),
        default=0.0,
    )
    target_confidence = max(
        (h.posterior for h in simulation.hypotheses if h.band == observation['band']),
        default=0.0,
    )
    novel_transition = (
        previous_hit_band is not None
        and previous_hit_band != observation['band']
        and simulation.transition_counts[(previous_hit_band, observation['band'])] == 0
    )
    updates = bayes_update(
        simulation.hypotheses,
        observation['band'],
        observation['start'],
        observation['dwell'],
        observation['hit'],
        simulation.now,
    )
    observation.update(
        {
            'index': len(simulation.observations) + 1,
            'prior_time': prior_time,
            'updates': updates,
            'informative': any(item['overlap'] >= 0.1 for item in updates),
            'surprise': False,
            'predictive_hit_likelihood': round(predictive_likelihood, 6),
            'selected_action': action,
        }
    )

    discovery_seen_before = simulation.last_seen[observation['band']]
    discovery_before = min(
        1.0,
        (prior_time - discovery_seen_before
         if discovery_seen_before >= 0
         else prior_time) / simulation.discovery_deadline,
    )
    if observation['informative']:
        simulation.last_seen[observation['band']] = simulation.now

    decay_events = []
    if observation['hit']:
        mature_model = len(simulation.hit_band_sequence) >= 1
        behavior_change = (
            not observation.get('false_alarm', False)
            and
            mature_model
            and novel_transition
            and target_confidence <= 0.25
            and not any(
                event['type'] == 'BEHAVIOUR_CHANGE_DETECTED'
                for event in simulation.events
            )
            and prior_time >= min(
                (emitter.get('change_time', float('inf'))
                 for emitter in simulation.scenario['emitters']
                 if emitter['kind'] == 'behavior_change'),
                default=float('inf'),
            )
        )
        model_surprise = not observation.get('false_alarm', False) and mature_model and predictive_likelihood < 0.30

        if behavior_change or model_surprise:
            observation['surprise'] = True
            simulation.recovery_until = simulation.now + simulation.discovery_deadline
            event_type = 'BEHAVIOUR_CHANGE_DETECTED' if behavior_change else 'MODEL_SURPRISE'
            transition = [previous_hit_band, observation['band']] if behavior_change else None
            simulation.events.append(
                {
                    'time': simulation.now,
                    'type': event_type,
                    'band': observation['band'],
                    'transition': transition,
                    'predictive_likelihood': round(predictive_likelihood, 6),
                    'message': (
                        f"Unexpected B{observation['band']} detection; predictive likelihood "
                        f"{predictive_likelihood:.3f}. Beliefs decayed and exploration increased."
                    ),
                }
            )
            for hypothesis in simulation.hypotheses:
                confidence_before = hypothesis.confidence
                stale_before = hypothesis.stale
                hypothesis.posterior *= float(simulation.scenario.get('evidence_decay_rate', 0.78))
                hypothesis.confidence = hypothesis.posterior
                hypothesis.stale = min(1.0, hypothesis.stale + 0.2)
                decay_events.append(
                    {
                        'hypothesis': hypothesis.id,
                        'confidence_before': round(confidence_before, 6),
                        'confidence_after': round(hypothesis.confidence, 6),
                        'stale_before': round(stale_before, 6),
                        'stale_after': round(hypothesis.stale, 6),
                    }
                )
            simulation.events[-1]['decayed_hypotheses'] = len(decay_events)

            new_hypothesis = Hypothesis(
                f"H-new-{observation['band']}-{len(simulation.observations) + 1}",
                observation['band'],
                period=12.0,
                phase=observation['start'] % 12.0,
                width=max(2.0, observation['overlap']),
                prior=0.16,
                posterior=0.16,
                confidence=0.16,
                history=[{'time': simulation.now, 'posterior': 0.16}],
                supports=[{'time': simulation.now, 'band': observation['band'], 'overlap': 1.0}],
                evidence=[
                    {
                        'time': simulation.now,
                        'band': observation['band'],
                        'observation': 'HIT',
                        'prior': 0.0,
                        'likelihood': round(predictive_likelihood, 6),
                        'posterior': 0.16,
                        'overlap': 1.0,
                        'reason': 'New hypothesis formed after a model surprise',
                    }
                ],
            )
            simulation.hypotheses.append(new_hypothesis)
            simulation.events[-1]['new_hypothesis'] = new_hypothesis.id

        if previous_hit_band is not None and not observation.get('false_alarm', False):
            simulation.transition_counts[(previous_hit_band, observation['band'])] += 1
        if not observation.get('false_alarm', False):
            simulation.hit_band_sequence.append(observation['band'])
    else:
        for hypothesis in simulation.hypotheses:
            if (
                hypothesis.band == observation['band']
                and hypothesis.last_supported is not None
                and simulation.now - hypothesis.last_supported > 20
            ):
                confidence_before = hypothesis.confidence
                stale_before = hypothesis.stale
                hypothesis.stale = min(1.0, hypothesis.stale + 0.03)
                decay_rate = float(simulation.scenario.get('evidence_decay_rate', 0.78))
                hypothesis.posterior *= 1.0 - (1.0 - 0.995) * decay_rate
                hypothesis.confidence = hypothesis.posterior
                decay_events.append(
                    {
                        'hypothesis': hypothesis.id,
                        'confidence_before': round(confidence_before, 6),
                        'confidence_after': round(hypothesis.confidence, 6),
                        'stale_before': round(stale_before, 6),
                        'stale_after': round(hypothesis.stale, 6),
                    }
                )

    simulation.change_detected = simulation.now < simulation.recovery_until
    discovery_risks = [
        min(1.0, (simulation.now - seen if seen >= 0 else simulation.now) / simulation.discovery_deadline)
        for seen in simulation.last_seen.values()
    ]
    maximum_discovery_risk = max(discovery_risks, default=0.0)

    if simulation.change_detected:
        simulation.mode = 'RECOVERY / EXPLORATION'
    elif maximum_discovery_risk >= float(simulation.scenario.get('exploration_threshold', 0.75)):
        simulation.mode = 'EXPLORATION'
    elif max((h.confidence for h in simulation.hypotheses), default=0.0) > float(simulation.scenario.get('confidence_threshold', 0.45)):
        simulation.mode = 'EXPLOITATION'
    else:
        simulation.mode = 'EXPLORATION'

    in_band_updates = [item for item in updates if item['band'] == observation['band']]
    strongest_update = max(in_band_updates, key=lambda item: item['overlap'], default=None)
    unaffected = [
        item for item in updates
        if not observation['hit'] and item['overlap'] < 0.1
    ]
    exclusion_gain = sum(
        max(0.0, item['prior'] - item['posterior']) for item in in_band_updates
    )
    observation['unaffected_hypotheses'] = unaffected
    observation['decay_events'] = decay_events
    observation['reasoning'] = {
        'observation': observation['observation'],
        'temporal_overlap': strongest_update['overlap'] if strongest_update else 0.0,
        'likelihood': strongest_update['likelihood'] if strongest_update else None,
        'posterior_before': strongest_update['prior'] if strongest_update else None,
        'posterior_after': strongest_update['posterior'] if strongest_update else None,
        'hypothesis_id': strongest_update['id'] if strongest_update else None,
        'posterior_change': strongest_update['change'] if strongest_update else None,
        'exclusion_gain': round(exclusion_gain, 6),
        'unaffected_hypotheses': unaffected,
        'decay_events': decay_events,
        'discovery_priority_before': round(discovery_before, 6),
        'behavior_change_detected': any(
            event['type'] == 'BEHAVIOUR_CHANGE_DETECTED'
            and event['time'] == simulation.now
            for event in simulation.events
        ),
        'mode': simulation.mode,
        'mode_reason': (
            'Recovery exploration after a model surprise'
            if simulation.change_detected
            else 'Discovery deadline increased exploration priority'
            if maximum_discovery_risk >= 0.75
            else 'Exploit informative learned hypotheses'
            if simulation.mode == 'EXPLOITATION'
            else 'Explore because belief confidence remains low'
        ),
    }

    simulation.observations.append(observation)
    action['mode'] = simulation.mode
    simulation.actions.append(action)
    return simulation.state() if include_state else None

def run_experiments(scenario, replicates=8, selected_methods=None):
    all_methods = ['random', 'sequential', 'fixed_priority', 'greedy', 'ucb', 'thompson', 'proposed']
    methods = [method for method in (selected_methods or all_methods) if method in all_methods]
    if not methods:
        methods = all_methods
    result = {'scenario': scenario, 'seed': scenario['seed'], 'replicates': replicates, 'methods': []}
    for method in methods:
        start = time.perf_counter()
        tracemalloc.start()
        det = []
        useful = []
        useful_counts = []
        bands = []
        delays = []
        scans = []
        discovery_delays = []
        rare_delays = []
        adaptation = []
        overhead = []
        rewards = []
        old_pattern_confidences = []
        change_detection_delays = []
        exploration_increases = []
        new_transition_counts = []
        for rep in range(replicates):
            sc = json.loads(json.dumps(scenario))
            sc['seed'] = scenario['seed'] + rep
            sim = Simulation(sc)
            change_time = min((e.get('change_time', scenario['horizon']) for e in sc['emitters'] if e['kind'] == 'behavior_change'), default=None)
            old_bands = {band for emitter in sc['emitters'] if emitter['kind'] == 'behavior_change' for band in emitter.get('old', [])}
            change_snapshot = None
            for _ in range(24):
                if change_time is not None and change_snapshot is None and sim.now >= change_time:
                    change_snapshot = {
                        'old_confidence': sum(h.posterior for h in sim.hypotheses if h.band in old_bands) / max(1, sum(h.band in old_bands for h in sim.hypotheses)),
                        'transitions': set(sim.transition_counts),
                        'exploration': sum(action.get('mode') in ('EXPLORATION', 'RECOVERY / EXPLORATION') for action in sim.actions) / max(1, len(sim.actions)),
                    }
                sim.step(method, include_state=False)
                if sim.now >= scenario['horizon']:
                    break
            scans += [len(sim.observations)]
            det.append(sum((o['hit'] for o in sim.observations)) / max(1, len(sim.observations)))
            useful.append(sum((o['hit'] and o['informative'] for o in sim.observations)) / max(1, len(sim.observations)))
            rewards.append(sum(o['hit'] and o['informative'] for o in sim.observations))
            useful_counts.append(sum(o['hit'] and o['informative'] for o in sim.observations))
            bands.append(len(set((o['band'] for o in sim.observations))))
            delays.append(next((o['end'] for o in sim.observations if o['hit']), scenario['horizon']))
            first_band = {}
            for o in sim.observations:
                first_band.setdefault(o['band'], o['end'])
            discovery_delays.append(sum(first_band.values()) / max(1, len(first_band)))
            rare_ids = {e['id'] for e in sc['emitters'] if e['kind'] == 'rare'}
            rare_delays.append(next((o['end'] for o in sim.observations if o['hit'] and rare_ids.intersection(o['active_emitters'])), scenario['horizon']))
            adaptation.append(next((o['end'] - change_time for o in sim.observations if change_time is not None and o['end'] >= change_time and o['hit'] and (o['band'] in (4, 8))), scenario['horizon'] - (change_time or 0)))
            if change_time is not None:
                snapshot = change_snapshot or {'old_confidence': sum(h.posterior for h in sim.hypotheses if h.band in old_bands) / max(1, sum(h.band in old_bands for h in sim.hypotheses)), 'transitions': set(), 'exploration': 0.0}
                old_pattern_confidences.append(snapshot['old_confidence'])
                change_event = next((event for event in sim.events if event['type'] in ('BEHAVIOUR_CHANGE_DETECTED', 'MODEL_SURPRISE') and event['time'] >= change_time), None)
                change_detection_delays.append(max(0.0, change_event['time'] - change_time) if change_event else scenario['horizon'] - change_time)
                post_actions = [action for action in sim.actions if action.get('start', 0) >= change_time]
                post_exploration = sum(action.get('mode') in ('EXPLORATION', 'RECOVERY / EXPLORATION') for action in post_actions) / max(1, len(post_actions))
                exploration_increases.append(max(0.0, post_exploration - snapshot['exploration']))
                new_transition_counts.append(sum(count for transition, count in sim.transition_counts.items() if transition not in snapshot['transitions']))
            overhead.append(sum((not o['hit'] for o in sim.observations)) / max(1, len(sim.observations)))
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        result['methods'].append({'algorithm': method, 'detection_rate': round(sum(det) / len(det), 3), 'useful_hit_rate': round(sum(useful) / len(useful), 3), 'useful_observations': round(sum(useful_counts) / len(useful_counts), 1), 'scans': round(sum(scans) / len(scans), 1), 'bands_scanned': round(sum(bands) / len(bands), 1), 'discovery_coverage': round(sum(bands) / (len(bands) * max(1, int(scenario.get('bands', 10)))), 3), 'time_to_useful_observation': round(sum(delays) / len(delays), 1), 'discovery_delay': round(sum(discovery_delays) / len(discovery_delays), 1), 'rare_emitter_discovery_time': round(sum(rare_delays) / len(rare_delays), 1), 'adaptation_time_after_change': round(sum(adaptation) / len(adaptation), 1), 'recovery_time': round(sum(adaptation) / len(adaptation), 1), 'old_pattern_confidence': round(sum(old_pattern_confidences) / len(old_pattern_confidences), 4) if old_pattern_confidences else None, 'time_to_detect_change': round(sum(change_detection_delays) / len(change_detection_delays), 1) if change_detection_delays else None, 'exploration_increase': round(sum(exploration_increases) / len(exploration_increases), 3) if exploration_increases else None, 'new_transitions_discovered': round(sum(new_transition_counts) / len(new_transition_counts), 1) if new_transition_counts else None, 'exploration_overhead': round(sum(overhead) / len(overhead), 3), 'cpu_seconds': round((time.perf_counter() - start) / replicates, 4), 'memory_peak_kb': round(peak / 1024, 1), 'cumulative_reward': round(sum(rewards) / len(rewards), 2)})
    return result
