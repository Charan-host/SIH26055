import { getApiBase } from "./api-base.js";
import DOMPurify from "dompurify";

const query = (selector) => document.querySelector(selector);
const API_BASE = getApiBase();

function renderHTML(element, markup) {
  const fragment = DOMPurify.sanitize(String(markup), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true },
  });
  element.replaceChildren(fragment);
}

let currentState;
let activeScenario = null;
let runLoop = false;
let selectedHypothesisId = null;
let selectedObservationIndex = null;
let lastComparison = null;
let comparisonScenarioId = null;
let localMode = false;
let localModeError = "";
let localSimulation = null;
let forceBackend = false;
let activeExperimentId = localStorage.getItem("scanGraphExperimentId") || "";
let generatedScenario = null;
let guidedStage = 0;
let guidedActive = false;
let speedMultiplier = 3;
let hypothesisSort = { key: "posterior", direction: -1 };
let inflightRequests = 0;
let toastTimer = null;

function apiPath(path) {
  if (path === "/simulation/state")
    return activeExperimentId
      ? `/api/experiments/${encodeURIComponent(activeExperimentId)}`
      : "/api/state";
  if (path === "/simulation/start") return "/api/experiments/start";
  if (path === "/simulation/step")
    return activeExperimentId
      ? `/api/experiments/${encodeURIComponent(activeExperimentId)}/step`
      : "/api/experiments/active/step";
  if (path === "/simulation/reset")
    return activeExperimentId
      ? `/api/experiments/${encodeURIComponent(activeExperimentId)}/reset`
      : "/api/experiments/active/reset";
  if (path === "/simulation/preview") return "/api/scenarios/preview";
  if (path === "/scenarios") return "/api/scenarios/generate";
  if (path === "/experiments/run") return "/api/baselines/run";
  return path;
}

function setBackendMode(local, detail = "") {
  localMode = local;
  localModeError = detail;
  const badge = query("#backendMode");
  badge.textContent = local ? "LOCAL SIMULATION MODE" : "LIVE BACKEND";
  badge.classList.toggle("offline", local);
  badge.title = local
    ? `Backend offline at ${API_BASE}. ${detail} Click to retry the backend connection.`
    : `Connected to SCAN-GRAPH API at ${API_BASE}. Click to recheck.`;
  query("#sidebarBackendStatus").textContent = local
    ? "LOCAL SIMULATION ACTIVE"
    : "LIVE BACKEND CONNECTED";
  query("#backendNotice").classList.toggle("hidden", !local);
}

function hashValue(text) {
  let hash = 2166136261;
  for (const character of String(text))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function deterministicUnit(text) {
  return hashValue(text) / 4294967295;
}

class LocalSimulation {
  constructor(scenario, active = true) {
    this.scenario = scenario || {
      id: "LOCAL-DEFAULT",
      name: "Behaviour Change",
      experiment_name: "Local Behaviour Change Experiment",
      seed: 7,
      horizon: 100,
      bands: 10,
      receiver_bandwidth_bands: 1,
      min_dwell_ms: 2,
      max_dwell_ms: 10,
      noise_level: 0.05,
      false_alarm_probability: 0.01,
      exploration_threshold: 0.75,
      exploration_rate: 0.15,
      confidence_threshold: 0.45,
      emitters: [
        {
          id: "E1",
          kind: "behavior_change",
          old: [2, 6, 9],
          new: [2, 4, 8],
          change_time: 40,
          period: 12,
          old_period: 12,
          new_period: 12,
          width: 5,
          old_width: 5,
          new_width: 5,
        },
      ],
    };
    this.active = active;
    this.now = 0;
    this.observations = [];
    this.actions = [];
    this.events = [];
    this.transitions = new Map();
    this.hitSequence = [];
    this.lastSeen = Array.from({ length: this.scenario.bands + 1 }, () => -1);
    this.discoveryDeadline = Number(this.scenario.discovery_deadline || 24);
    this.mode = "EXPLORATION";
    this.recoveryUntil = -1;
    this.hypotheses = [];
    for (let band = 1; band <= this.scenario.bands; band += 1) {
      for (const [period, prior] of [
        [12, 0.055],
        [20, 0.055],
        [30, 0.04],
      ]) {
        this.hypotheses.push({
          id: `H${band}-P${period}`,
          band,
          kind: "periodic",
          period,
          phase: (band * 3) % period,
          width: 5,
          prior,
          posterior: prior,
          confidence: prior,
          last_supported: null,
          last_contradicted: null,
          stale: 0,
          history: [{ time: 0, posterior: prior }],
          supports: [],
          contradictions: [],
          evidence: [],
        });
      }
    }
  }
  emitterBand(emitter, time) {
    if (emitter.kind === "behavior_change") {
      const changed = time >= Number(emitter.change_time || 0);
      const sequence = changed ? emitter.new : emitter.old;
      const period = Number(
        changed
          ? emitter.new_period || emitter.period || 20
          : emitter.old_period || emitter.period || 20,
      );
      return sequence[
        Math.floor(
          Math.max(0, time - (changed ? emitter.change_time : 0)) / period,
        ) % sequence.length
      ];
    }
    if (emitter.kind === "agile") {
      const bands = emitter.bands || [2, 4, 7];
      const hop = Math.floor(
        Math.max(0, time - Number(emitter.phase || 0)) /
          Number(emitter.period || 20),
      );
      if (emitter.hop_pattern === "random")
        return bands[hashValue(`${this.scenario.seed}:${hop}`) % bands.length];
      return bands[hop % bands.length];
    }
    return Number(emitter.band || 2);
  }
  truthWindows() {
    const windows = [];
    for (const emitter of this.scenario.emitters || []) {
      const period = Number(emitter.period || 20);
      const width = Number(emitter.width || 4);
      if (emitter.kind === "behavior_change") {
        for (
          let start = 0;
          start < this.scenario.horizon;
          start += Math.max(1, Number(emitter.old_period || period))
        ) {
          if (start < emitter.change_time)
            windows.push({
              band: this.emitterBand(emitter, start),
              start,
              end: Math.min(
                start + Number(emitter.old_width || width),
                emitter.change_time,
              ),
              emitter: emitter.id,
            });
        }
        const newPeriod = Number(emitter.new_period || period);
        for (
          let start = Number(emitter.change_time);
          start < this.scenario.horizon;
          start += Math.max(1, newPeriod)
        )
          windows.push({
            band: this.emitterBand(emitter, start),
            start,
            end: Math.min(
              start + Number(emitter.new_width || width),
              this.scenario.horizon,
            ),
            emitter: emitter.id,
          });
      } else {
        for (
          let start = Number(emitter.phase || 0);
          start < this.scenario.horizon;
          start += Math.max(1, period)
        ) {
          if (
            emitter.kind === "rare" &&
            deterministicUnit(`${this.scenario.seed}:${emitter.id}:${start}`) >
              Number(emitter.probability || 0.12)
          )
            continue;
          windows.push({
            band: this.emitterBand(emitter, start),
            start,
            end: Math.min(start + width, this.scenario.horizon),
            emitter: emitter.id,
          });
        }
      }
    }
    return windows;
  }
  predictedWindows() {
    return this.hypotheses
      .filter((hypothesis) => hypothesis.posterior >= 0.025)
      .map((hypothesis) => {
        const windows = [];
        for (
          let start = hypothesis.phase;
          start < this.scenario.horizon;
          start += hypothesis.period
        )
          windows.push({
            band: hypothesis.band,
            start,
            end: Math.min(start + hypothesis.width, this.scenario.horizon),
            hypothesis: hypothesis.id,
            posterior: hypothesis.posterior,
          });
        return windows;
      })
      .flat();
  }
  overlap(start, end, a, b) {
    return Math.max(0, Math.min(end, b) - Math.max(start, a));
  }
  scoreActions() {
    const dwellOptions = [
      ...new Set(
        [
          Number(this.scenario.min_dwell_ms || 2),
          4,
          6,
          Number(this.scenario.max_dwell_ms || 10),
        ].filter((value) => value > 0),
      ),
    ];
    const slotCount = Number(this.scenario.time_slots || 0);
    const slotWidth = slotCount ? this.scenario.horizon / slotCount : 0;
    const firstSlot = slotCount
      ? Math.ceil((this.now - 1e-9) / Math.max(slotWidth, 1e-9))
      : 0;
    const starts = slotCount
      ? Array.from(
          { length: Math.max(0, Math.min(5, slotCount - firstSlot)) },
          (_, index) => Math.round((firstSlot + index) * slotWidth * 10) / 10,
        )
      : [this.now, this.now + 2, this.now + 4, this.now + 6, this.now + 8];
    const actions = [];
    for (let band = 1; band <= this.scenario.bands; band += 1)
      for (const start of starts)
        for (const dwell of dwellOptions) {
          if (start + dwell > this.scenario.horizon) continue;
          const matching = this.hypotheses.filter(
            (hypothesis) => hypothesis.band === band,
          );
          const information =
            matching.reduce(
              (sum, h) => sum + 4 * h.posterior * (1 - h.posterior),
              0,
            ) / Math.max(1, matching.length);
          const risk = Math.min(
            1,
            Math.max(
              0,
              (this.now -
                (this.lastSeen[band] >= 0 ? this.lastSeen[band] : 0)) /
                this.discoveryDeadline,
            ),
          );
          const transitions =
            (this.hitSequence.length &&
              this.transitions.get(`${this.hitSequence.at(-1)}:${band}`)) ||
            0;
          const score =
            information +
            0.25 * risk +
            0.1 * Math.min(1, transitions) -
            0.01 * dwell;
          actions.push({
            band,
            start,
            dwell,
            score,
            information_gain: information,
            exclusion_gain: information * 0.6,
            discovery_priority: risk,
            transition_relevance: Math.min(1, transitions),
            redundancy_penalty: 0.01 * dwell,
            expected_overlap: matching.reduce((sum, h) => sum + h.posterior, 0),
            reason:
              risk > 0.7
                ? "Discovery protection for an unobserved or overdue band."
                : information > 0.03
                  ? "Expected information and exclusion value for active hypotheses."
                  : "Transition and uncertainty balance with low redundant exposure.",
          });
        }
    return actions.sort((a, b) => b.score - a.score);
  }
  state() {
    const truth = this.truthWindows();
    const predicted = this.predictedWindows();
    const candidates = this.scoreActions();
    const next = candidates[0] || null;
    const transitions = [...this.transitions.entries()].map(([key, count]) => ({
      from: Number(key.split(":")[0]),
      to: Number(key.split(":")[1]),
      count,
    }));
    const discovery = Array.from(
      { length: this.scenario.bands },
      (_, index) => {
        const band = index + 1;
        const last = this.lastSeen[band];
        const age = last < 0 ? this.now : this.now - last;
        return {
          band,
          last_meaningful_observation: last < 0 ? null : last,
          risk: Math.min(1, age / this.discoveryDeadline),
          age,
        };
      },
    );
    const certificate = this.certificate();
    const last = this.observations.at(-1);
    return {
      experiment_active: this.active,
      experiment_id: this.scenario.id,
      scenario: this.scenario,
      time: this.now,
      receiver_bandwidth_bands: this.scenario.receiver_bandwidth_bands || 1,
      exploration_ratio:
        this.actions.filter((action) => action.mode !== "EXPLOITATION").length /
        Math.max(1, this.actions.length),
      graph_confidence:
        1 -
        Math.exp(-transitions.reduce((sum, item) => sum + item.count, 0) / 8),
      observations: this.observations,
      hypotheses: this.hypotheses,
      candidates: candidates.slice(0, 8),
      mode: this.mode,
      events: this.events,
      discovery,
      timeline: {
        horizon: this.scenario.horizon,
        truth_windows: truth,
        predicted_windows: predicted,
        change_points: (this.scenario.emitters || [])
          .filter((e) => e.kind === "behavior_change")
          .map((e) => ({ time: e.change_time })),
      },
      next_action: next,
      reasoning: last?.reasoning || {
        observation: "Waiting for first receiver scan",
        temporal_overlap: null,
        likelihood: null,
        posterior_before: null,
        posterior_after: null,
        exclusion_gain: null,
        discovery_check: discovery,
        next_action: next,
      },
      transitions,
      recovery_until: this.recoveryUntil,
      certificate,
    };
  }
  certificate() {
    const excluded = this.hypotheses
      .filter((h) => h.posterior < 0.025 && h.contradictions.length)
      .map((h) => ({
        id: h.id,
        band: h.band,
        posterior: h.posterior,
        reason: h.contradictions.at(-1).reason,
        evidence: h.evidence.filter((e) => e.observation === "MISS"),
      }));
    const weakened = this.hypotheses
      .filter((h) => h.contradictions.length && h.posterior >= 0.025)
      .map((h) => ({
        id: h.id,
        band: h.band,
        posterior: h.posterior,
        evidence: h.contradictions,
      }));
    return {
      scenario_id: this.scenario.id,
      time_window: [0, this.now],
      scans_performed: this.observations.length,
      scans: this.observations,
      hypotheses_considered: this.hypotheses.length,
      excluded_hypotheses: excluded,
      weakened_hypotheses: weakened,
      remaining_plausible: this.hypotheses
        .filter((h) => h.posterior >= 0.025)
        .map((h) => ({ id: h.id, band: h.band, posterior: h.posterior })),
      unaffected_by_misses: this.observations
        .filter((o) => o.observation === "MISS" && !o.informative)
        .map((o) => ({
          observation_index: o.index,
          band: o.band,
          start: o.start,
          end: o.end,
          unaffected_hypotheses: o.unaffected_hypotheses,
        })),
      behaviour_change_events: this.events,
      learned_transitions: [...this.transitions.entries()].map(
        ([key, count]) => ({
          from: Number(key.split(":")[0]),
          to: Number(key.split(":")[1]),
          count,
        }),
      ),
      discovery_status: this.stateDiscovery(),
      confidence: Math.min(
        1,
        this.observations.filter((o) => o.informative).length / 8,
      ),
      scheduler_decisions: this.actions,
    };
  }
  stateDiscovery() {
    return Array.from({ length: this.scenario.bands }, (_, index) => {
      const band = index + 1,
        last = this.lastSeen[band];
      return {
        band,
        last_meaningful_observation: last < 0 ? null : last,
        risk: Math.min(
          1,
          (this.now - (last < 0 ? 0 : last)) / this.discoveryDeadline,
        ),
      };
    });
  }
  step(method = "proposed") {
    const candidates = this.scoreActions();
    let action = candidates[0];
    if (method === "random")
      action =
        candidates[
          hashValue(`${this.scenario.seed}:${this.observations.length}`) %
            Math.max(1, candidates.length)
        ];
    if (method === "sequential")
      action =
        candidates.find(
          (item) =>
            item.band === (this.observations.length % this.scenario.bands) + 1,
        ) || action;
    if (method === "fixed_priority") {
      const order = [2, 4, 6, 8, 1, 3, 5, 7, 9];
      action =
        candidates.find(
          (item) =>
            item.band === (order[this.observations.length % order.length] || 1),
        ) || action;
    }
    if (method === "greedy")
      action =
        [...candidates].sort(
          (a, b) => b.information_gain - a.information_gain,
        )[0] || action;
    if (method === "ucb")
      action =
        [...candidates].sort(
          (a, b) =>
            b.score +
            Math.sqrt(
              (2 * Math.log(this.observations.length + 2)) /
                (1 + this.observations.filter((o) => o.band === b.band).length),
            ) -
            (a.score +
              Math.sqrt(
                (2 * Math.log(this.observations.length + 2)) /
                  (1 +
                    this.observations.filter((o) => o.band === a.band).length),
              )),
        )[0] || action;
    if (method === "thompson")
      action =
        [...candidates].sort(
          (a, b) =>
            b.expected_overlap +
            deterministicUnit(
              `${this.scenario.seed}:${this.observations.length}:${b.band}`,
            ) -
            (a.expected_overlap +
              deterministicUnit(
                `${this.scenario.seed}:${this.observations.length}:${a.band}`,
              )),
        )[0] || action;
    if (
      method === "proposed" &&
      this.mode !== "EXPLOITATION" &&
      deterministicUnit(
        `${this.scenario.seed}:${this.observations.length}:explore`,
      ) < Number(this.scenario.exploration_rate || 0)
    )
      action =
        [...candidates].sort(
          (a, b) =>
            b.discovery_priority - a.discovery_priority || b.score - a.score,
        )[0] || action;
    if (!action) return this.state();
    const start = action.start,
      dwell = action.dwell,
      end = Math.min(this.scenario.horizon, start + dwell);
    const truth = this.truthWindows().filter(
      (window) => window.band === action.band,
    );
    const actualOverlap = truth.reduce(
      (sum, window) => sum + this.overlap(start, end, window.start, window.end),
      0,
    );
    const hit =
      actualOverlap > 0
        ? deterministicUnit(
            `${this.scenario.seed}:${action.band}:${start}:${dwell}`,
          ) > Number(this.scenario.noise_level || 0)
        : deterministicUnit(
            `${this.scenario.seed}:${action.band}:${start}:${dwell}:false`,
          ) < Number(this.scenario.false_alarm_probability || 0);
    const updates = [];
    for (const hypothesis of this.hypotheses) {
      let overlap = 0;
      if (hypothesis.band === action.band)
        for (
          let cycle = -1;
          cycle < Math.ceil(end / hypothesis.period) + 1;
          cycle += 1
        )
          overlap = Math.max(
            overlap,
            this.overlap(
              start,
              end,
              hypothesis.phase + cycle * hypothesis.period,
              hypothesis.phase + cycle * hypothesis.period + hypothesis.width,
            ) / Math.max(dwell, 1e-9),
          );
      const prior = hypothesis.posterior;
      const pHit = 0.03 + 0.92 * overlap;
      const likelihood = hit ? pHit : 1 - pHit;
      const baseline = hit ? 0.03 : 0.97;
      const posterior =
        (prior * likelihood) /
        (prior * likelihood + (1 - prior) * baseline || 1);
      hypothesis.posterior = posterior;
      hypothesis.confidence = posterior;
      const evidence = {
        time: end,
        band: action.band,
        start,
        end,
        observation: hit ? "HIT" : "MISS",
        prior,
        likelihood,
        posterior,
        overlap,
        reason:
          hit && overlap > 0.1
            ? "Supported by overlapping detection"
            : !hit && overlap >= 0.1
              ? "Contradicted by predicted activity"
              : "Not penalized because activity was not observable",
      };
      hypothesis.evidence.push(evidence);
      if (hit && overlap >= 0.1)
        hypothesis.supports.push({ time: end, band: action.band, overlap });
      if (!hit && overlap >= 0.1) hypothesis.contradictions.push(evidence);
      hypothesis.history.push({ time: end, posterior });
      updates.push({
        id: hypothesis.id,
        band: hypothesis.band,
        prior,
        likelihood,
        posterior,
        overlap,
        change: posterior - prior,
      });
    }
    const bandUpdates = updates.filter((item) => item.band === action.band);
    const strongest = bandUpdates.sort((a, b) => b.overlap - a.overlap)[0];
    const previous = this.hitSequence.at(-1);
    if (hit) {
      if (previous) {
        const key = `${previous}:${action.band}`;
        this.transitions.set(key, (this.transitions.get(key) || 0) + 1);
      }
      this.hitSequence.push(action.band);
    }
    const confidence =
      hit && actualOverlap > 0
        ? Math.min(1, 0.75 + (0.25 * actualOverlap) / Math.max(dwell, 1)) *
          (1 - Number(this.scenario.noise_level || 0))
        : 0;
    const observation = {
      index: this.observations.length + 1,
      band: action.band,
      start,
      end,
      dwell,
      hit,
      observation: hit ? "HIT" : "MISS",
      overlap: actualOverlap,
      signal_strength: Number(
        (
          Math.min(1, actualOverlap / Math.max(dwell, 1e-9)) *
          (1 - Number(this.scenario.noise_level || 0))
        ).toFixed(3),
      ),
      detection_confidence: Number(confidence.toFixed(3)),
      active_emitters: truth
        .filter((item) => this.overlap(start, end, item.start, item.end) > 0)
        .map((item) => item.emitter),
      informative: bandUpdates.some((item) => item.overlap >= 0.1),
      updates,
      selected_action: action,
      reasoning: {
        observation: hit ? "HIT" : "MISS",
        temporal_overlap: strongest?.overlap || 0,
        likelihood: strongest?.likelihood ?? null,
        posterior_before: strongest?.prior ?? null,
        posterior_after: strongest?.posterior ?? null,
        hypothesis_id: strongest?.id || null,
        exclusion_gain: bandUpdates.reduce(
          (sum, item) => sum + Math.max(0, item.prior - item.posterior),
          0,
        ),
        unaffected_hypotheses: updates.filter(
          (item) => !hit && item.overlap < 0.1,
        ),
        discovery_priority_before: Math.min(
          1,
          (this.now -
            (this.lastSeen[action.band] < 0 ? 0 : this.lastSeen[action.band])) /
            this.discoveryDeadline,
        ),
      },
    };
    this.observations.push(observation);
    this.now = end;
    if (observation.informative) this.lastSeen[action.band] = end;
    const changeEmitter = this.scenario.emitters.find(
      (emitter) => emitter.kind === "behavior_change",
    );
    const behaviorChange = Boolean(
      changeEmitter &&
      start >= changeEmitter.change_time &&
      hit &&
      previous &&
      action.band !== previous &&
      !this.events.some((event) => event.type === "BEHAVIOUR_CHANGE_DETECTED"),
    );
    if (behaviorChange) {
      this.events.push({
        time: end,
        type: "BEHAVIOUR_CHANGE_DETECTED",
        band: action.band,
        message: `Unexpected B${action.band} detection after configured behaviour change. Beliefs decayed and exploration increased.`,
      });
      this.recoveryUntil = end + this.discoveryDeadline;
      for (const hypothesis of this.hypotheses) {
        hypothesis.posterior *= 0.78;
        hypothesis.confidence = hypothesis.posterior;
      }
    }
    this.mode =
      end < this.recoveryUntil
        ? "RECOVERY / EXPLORATION"
        : hit
          ? "EXPLOITATION"
          : "EXPLORATION";
    this.actions.push({ ...action, mode: this.mode });
    return this.state();
  }
}

function persistLocalSimulation() {
  if (!localSimulation) return;
  try {
    sessionStorage.setItem(
      "scanGraphLocalSimulation",
      JSON.stringify({
        scenario: localSimulation.scenario,
        active: localSimulation.active,
        now: localSimulation.now,
        observations: localSimulation.observations,
        actions: localSimulation.actions,
        events: localSimulation.events,
        transitions: [...localSimulation.transitions],
        hitSequence: localSimulation.hitSequence,
        lastSeen: localSimulation.lastSeen,
        mode: localSimulation.mode,
        recoveryUntil: localSimulation.recoveryUntil,
        hypotheses: localSimulation.hypotheses,
      }),
    );
  } catch {
    /* Storage is optional; the in-memory simulation remains active. */
  }
}

function restoreLocalSimulation() {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem("scanGraphLocalSimulation") || "null",
    );
    if (!saved) return;
    localSimulation = new LocalSimulation(saved.scenario, saved.active);
    for (const key of [
      "now",
      "observations",
      "actions",
      "events",
      "hitSequence",
      "lastSeen",
      "mode",
      "recoveryUntil",
      "hypotheses",
    ])
      if (saved[key] !== undefined) localSimulation[key] = saved[key];
    localSimulation.transitions = new Map(saved.transitions || []);
    setBackendMode(
      true,
      "Restored this tab’s local experiment. Click to retry the live API.",
    );
  } catch {
    sessionStorage.removeItem("scanGraphLocalSimulation");
  }
}

restoreLocalSimulation();

function setLocalSimulationMode(error) {
  const raw = error?.message || String(error || "Network request failed");
  const detail = `Cannot connect to SCAN-GRAPH API at ${API_BASE}. Start the backend with “python -m backend”. (${raw})`;
  setBackendMode(true, detail);
}

function adoptCurrentStateLocally(state) {
  if (!state?.scenario) return;
  localSimulation = new LocalSimulation(state.scenario, true);
  localSimulation.now = state.time || 0;
  localSimulation.observations = structuredClone(state.observations || []);
  localSimulation.hypotheses = structuredClone(
    state.hypotheses || localSimulation.hypotheses,
  );
  localSimulation.actions = structuredClone(
    state.certificate?.scheduler_decisions || [],
  );
  localSimulation.events = structuredClone(state.events || []);
  localSimulation.transitions = new Map(
    (state.transitions || []).map((edge) => [
      `${edge.from}:${edge.to}`,
      edge.count,
    ]),
  );
  localSimulation.hitSequence = (state.observations || [])
    .filter((observation) => observation.hit && !observation.false_alarm)
    .map((observation) => observation.band);
  for (const item of state.discovery || [])
    localSimulation.lastSeen[item.band] =
      item.last_meaningful_observation ?? -1;
  localSimulation.mode = state.mode || "EXPLORATION";
  localSimulation.recoveryUntil = state.recovery_until || -1;
}

async function localRequest(path, body = {}) {
  if (path === "/health" || path === "/api/health")
    return { status: "ok", service: "local-scan-graph-simulation" };
  if (path === "/simulation/state")
    return localSimulation?.state() || new LocalSimulation(null, false).state();
  if (path === "/simulation/preview") {
    const sim = new LocalSimulation(body.scenario);
    const state = sim.state();
    return {
      scenario: state.scenario,
      timeline: state.timeline,
      next_action: state.next_action,
      hypotheses: state.hypotheses,
      candidates: state.candidates,
    };
  }
  if (path === "/scenarios") return body.scenario || body;
  if (path === "/simulation/start") {
    localSimulation = new LocalSimulation(
      body.scenario || new LocalSimulation(null, false).scenario,
      true,
    );
    localSimulation.active = true;
    activeExperimentId = "";
    localStorage.removeItem("scanGraphExperimentId");
    persistLocalSimulation();
    return localSimulation.state();
  }
  if (path === "/simulation/reset") {
    localSimulation = new LocalSimulation(
      body.scenario || localSimulation?.scenario,
      true,
    );
    persistLocalSimulation();
    return localSimulation.state();
  }
  if (path === "/simulation/step") {
    if (!localSimulation?.active)
      throw new Error(
        "Create and start an experiment before requesting a scan.",
      );
    const state = localSimulation.step(body.algorithm || "proposed");
    persistLocalSimulation();
    return state;
  }
  if (path === "/experiments/run")
    return localRunExperiments(
      body.scenario,
      body.replicates || 1,
      body.methods,
    );
  throw new Error(`The local simulation does not implement ${path}.`);
}

function localRunExperiments(scenario, replicates = 1, methods) {
  const names = methods?.length
    ? methods
    : [
        "random",
        "sequential",
        "fixed_priority",
        "greedy",
        "ucb",
        "thompson",
        "proposed",
      ];
  const rows = [];
  for (const algorithm of names) {
    const started = performance.now(),
      useful = [],
      scans = [],
      bands = [],
      delays = [],
      exploration = [],
      adaptation = [];
    for (let replicate = 0; replicate < replicates; replicate += 1) {
      const pairedScenario = {
        ...scenario,
        seed: Number(scenario.seed || 0) + replicate,
      };
      const simulation = new LocalSimulation(pairedScenario);
      for (
        let index = 0;
        index < 24 && simulation.now < scenario.horizon;
        index += 1
      )
        simulation.step(algorithm);
      const observations = simulation.observations;
      useful.push(
        observations.filter((item) => item.hit && item.informative).length,
      );
      scans.push(observations.length);
      bands.push(new Set(observations.map((item) => item.band)).size);
      delays.push(
        observations.find((item) => item.hit && item.informative)?.end ||
          scenario.horizon,
      );
      exploration.push(
        simulation.actions.filter((action) => action.mode !== "EXPLOITATION")
          .length / Math.max(1, simulation.actions.length),
      );
      const point = scenario.emitters.find(
        (item) => item.kind === "behavior_change",
      )?.change_time;
      adaptation.push(
        point == null
          ? null
          : observations.find(
              (item) =>
                item.end >= point && item.hit && [4, 8].includes(item.band),
            )?.end - point || scenario.horizon - point,
      );
    }
    const average = (items) =>
      items
        .filter((item) => item != null)
        .reduce((sum, item) => sum + item, 0) /
      Math.max(1, items.filter((item) => item != null).length);
    rows.push({
      algorithm,
      useful_observations: Number(average(useful).toFixed(1)),
      useful_hit_rate: Number(
        (average(useful) / Math.max(1, average(scans))).toFixed(3),
      ),
      scans: Number(average(scans).toFixed(1)),
      bands_scanned: Number(average(bands).toFixed(1)),
      discovery_coverage: Number(
        (average(bands) / Math.max(1, scenario.bands)).toFixed(3),
      ),
      time_to_useful_observation: Number(average(delays).toFixed(1)),
      recovery_time: adaptation.some((item) => item != null)
        ? Number(average(adaptation).toFixed(1))
        : null,
      adaptation_time_after_change: adaptation.some((item) => item != null)
        ? Number(average(adaptation).toFixed(1))
        : null,
      exploration_overhead: Number(average(exploration).toFixed(3)),
      cpu_seconds: Number(
        (
          (performance.now() - started) /
          1000 /
          Math.max(1, replicates)
        ).toFixed(4),
      ),
      old_pattern_confidence: null,
      time_to_detect_change: null,
      exploration_increase: null,
      new_transitions_discovered: null,
    });
  }
  return {
    id: `LOCAL-${hashValue(JSON.stringify(scenario)).toString(16)}`,
    scenario,
    seed: scenario.seed,
    replicates,
    methods: rows,
    mode: "LOCAL SIMULATION",
  };
}

function showRequestToast(message) {
  const toast = query("#requestToast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 6500);
}

async function apiFetch(url, options = {}, timeoutMs = 15000) {
  inflightRequests += 1;
  query("#requestLoading").classList.remove("hidden");
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)} seconds: ${new URL(url).pathname}`,
      );
    }
    throw error;
  } finally {
    inflightRequests = Math.max(0, inflightRequests - 1);
    if (!inflightRequests) query("#requestLoading").classList.add("hidden");
  }
}

async function request(path, body, timeoutMs = 15000) {
  const options = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  if (localMode && !forceBackend) {
    try {
      return await localRequest(path, body);
    } catch (error) {
      showRequestToast(error.message);
      throw error;
    }
  }
  try {
    const response = await apiFetch(
      new URL(apiPath(path), API_BASE),
      options,
      timeoutMs,
    );
    const result = await response.json().catch(() => ({}));
    if (
      !response.ok &&
      response.status === 404 &&
      activeExperimentId &&
      path === "/simulation/state"
    ) {
      activeExperimentId = "";
      localStorage.removeItem("scanGraphExperimentId");
      const fallbackResponse = await fetch(new URL("/api/state", API_BASE));
      const fallbackState = await fallbackResponse.json();
      setBackendMode(false);
      return fallbackState;
    }
    if (!response.ok)
      throw Object.assign(
        new Error(result.error || `${response.status} ${response.statusText}`),
        { status: response.status },
      );
    if (path === "/simulation/start" && result.experiment_id) {
      activeExperimentId = result.experiment_id;
      localStorage.setItem("scanGraphExperimentId", activeExperimentId);
    }
    setBackendMode(false);
    return result;
  } catch (error) {
    if (error.status) {
      showRequestToast(error.message);
      throw error;
    }
    setLocalSimulationMode(error);
    if (!localSimulation?.active && currentState?.experiment_active)
      adoptCurrentStateLocally(currentState);
    persistLocalSimulation();
    return localRequest(path, body);
  }
}

function renderSpectrum(state) {
  const lastScan = state.observations.at(-1);
  const selected = lastScan || state.next_action;
  const horizon = state.timeline.horizon;
  renderHTML(query(".axis"), Array.from(
    { length: 6 },
    (_, index) =>
      `<span>${Math.round((horizon * index) / 5)}${index === 0 || index === 5 ? " ms" : ""}</span>`,
  ).join(""));
  const rows = [];

  for (let band = 1; band <= (state.scenario.bands || 10); band += 1) {
    const truth = state.timeline.truth_windows
      .filter((item) => item.band === band)
      .map(
        (item) =>
          `<i class="activity truth-window" data-start="${item.start}" data-end="${item.end}" title="${item.emitter}: ground truth"></i>`,
      )
      .join("");
    const predictions = state.timeline.predicted_windows
      .filter((item) => item.band === band)
      .map(
        (item) =>
          `<i class="activity pred-window" data-start="${item.start}" data-end="${item.end}" title="${item.hypothesis}: prediction"></i>`,
      )
      .join("");
    const hits = state.observations
      .filter((item) => item.band === band && item.observation === "HIT")
      .map(
        (item) =>
          `<i class="hitmark" data-start="${item.start}" data-end="${item.end}" title="B${band} · ${item.start.toFixed(1)}–${item.end.toFixed(1)} ms · HIT · overlap ${item.overlap.toFixed(2)} ms"></i>`,
      )
      .join("");
    const misses = state.observations
      .filter((item) => item.band === band && item.observation === "MISS")
      .map(
        (item) =>
          `<i class="missmark" data-start="${item.start}" data-end="${item.end}" title="B${band} · ${item.start.toFixed(1)}–${item.end.toFixed(1)} ms · MISS · ${item.informative ? "informative overlap" : "dwell did not overlap predicted activity"}"></i>`,
      )
      .join("");
    const scan =
      selected?.band === band
        ? `<i class="scanwin" data-start="${selected.start}" data-end="${selected.start + selected.dwell}" title="B${band} · ${selected.start.toFixed(1)}–${(selected.start + selected.dwell).toFixed(1)} ms · dwell ${selected.dwell} ms · ${lastScan?.observation || "chosen scan window"}"></i>`
        : "";
    rows.push(
      `<div class="bandrow" role="listitem" tabindex="0" aria-label="Band ${band} spectrum and scan history"><b>B${band}</b><div class="track">${truth}${predictions}${hits}${misses}${scan}</div></div>`,
    );
  }

  const bandList = query("#bands");
  renderHTML(bandList, rows.join(""));
  bandList
    .querySelectorAll(".activity, .hitmark, .missmark, .scanwin")
    .forEach((marker) => {
      const start = Number(marker.dataset.start);
      const end = Number(marker.dataset.end);
      marker.style.left = `${(start / horizon) * 100}%`;
      marker.style.width = `${Math.max(0.6, ((end - start) / horizon) * 100)}%`;
    });
  state.timeline.change_points.forEach((point) => {
    bandList.querySelectorAll(".track").forEach((track) => {
      const marker = document.createElement("i");
      marker.className = "change-marker";
      marker.style.left = `${(point.time / horizon) * 100}%`;
      marker.title = `Behavior change at ${point.time} ms`;
      track.append(marker);
    });
  });
  query("#window").textContent = selected
    ? `${lastScan ? "Observed" : "Scheduled"} B${selected.band} · ${selected.start.toFixed(1)}–${(selected.start + selected.dwell).toFixed(1)} ms · dwell ${selected.dwell} ms`
    : "No scan action available";
  query("#timelineMeta").textContent =
    `Truth activity, predicted windows, and ${lastScan ? "last" : "initial scheduled"} receiver window${state.timeline.change_points.length ? ` · configured behavior change at ${state.timeline.change_points[0].time} ms` : ""}.`;
}

function renderCandidates(state) {
  const [best, ...others] = state.candidates;
  query("#whyScan").textContent = best
    ? `B${best.band} is next because ${best.reason.toLowerCase()} It is scheduled at ${best.start.toFixed(1)} ms for ${best.dwell} ms.`
    : "No scan action is available in the remaining observation window.";
  renderHTML(query("#decision"), best
    ? `<div class="decision-action"><strong>B${best.band} · ${best.start} ms · ${best.dwell} ms</strong><p>${state.mode} · ${best.reason}</p><p>Backend score ${Number(best.score ?? 0).toFixed(9)}</p><small>Information ${Number(best.information_gain ?? 0).toFixed(3)} · overlap ${Number(best.expected_overlap ?? 0).toFixed(3)} · exclusion ${Number(best.elimination_gain ?? best.exclusion_gain ?? 0).toFixed(3)} · discovery ${Number(best.discovery_priority ?? 0).toFixed(3)} · rare ${Number(best.rare_priority ?? 0).toFixed(3)} · cost ${Number(best.scan_cost ?? best.dwell ?? 0).toFixed(2)} · redundancy ${Number(best.redundancy_penalty ?? 0).toFixed(2)}</small></div>`
    : '<div class="empty">No available scan action.</div>');
  renderHTML(query("#candidates"), others
    .slice(0, 5)
    .map(
      (item, index) =>
        `<div class="candidate"><b>${index + 2}</b><span>B${item.band} · ${item.start} ms · ${item.dwell} ms<br>${item.reason}</span><span class="score">${item.score.toFixed(9)}</span></div>`,
    )
    .join(""));
}

function renderBeliefs(state) {
  renderHTML(query("#beliefs"), state.hypotheses
    .slice(0, 10)
    .map(
      (item) =>
        `<div class="beliefrow"><b>${item.id}</b><div class="bar"><i style="width:${Math.min(100, item.posterior * 100)}%"></i></div><span>${item.posterior.toFixed(3)}</span></div>`,
    )
    .join(""));
  renderHTML(query("#hypTable"),
    `<table class="table"><thead><tr><th>ID</th><th>BAND</th><th>POSTERIOR</th><th>LAST SUPPORT</th><th>STALE</th><th>SUPPORTS</th><th>CONTRADICTIONS</th></tr></thead><tbody>${state.hypotheses
      .map(
        (item) =>
          `<tr><td>${item.id}</td><td>B${item.band}</td><td>${item.posterior.toFixed(4)}</td><td>${item.last_supported ?? "—"}</td><td>${item.stale.toFixed(2)}</td><td>${item.supports.length}</td><td>${item.contradictions.length}</td></tr>`,
      )
      .join("")}</tbody></table>`);
}

function renderDiscovery(state) {
  renderHTML(query("#discovery"), state.discovery
    .map((item) => {
      const level =
        item.risk > 0.75 ? "HIGH" : item.risk > 0.35 ? "MED" : "LOW";
      const last =
        item.last_meaningful_observation == null
          ? "Unobserved"
          : `last ${item.last_meaningful_observation} ms`;
      return `<div class="discoveryrow"><b>B${item.band}</b><div><div class="riskbar"><i style="width:${item.risk * 100}%"></i></div><small>${last} · age ${item.age.toFixed(1)} ms · risk ${item.risk.toFixed(2)}</small></div><span>${level}</span></div>`;
    })
    .join(""));
}

function renderTransitionGraph(state) {
  const transitions = state.transitions || [];
  const container = query("#transitionGraph");
  if (!transitions.length) {
    container.textContent =
      "Cross-band transition edges appear after consecutive HIT observations. No transition has been learned yet.";
    return;
  }
  const width = Math.max(560, state.scenario.bands * 62);
  const spacing = (width - 72) / Math.max(1, state.scenario.bands - 1);
  const position = (band) => ({ x: 36 + (band - 1) * spacing, y: 58 });
  const totals = new Map();
  transitions.forEach((edge) =>
    totals.set(edge.from, (totals.get(edge.from) || 0) + edge.count),
  );
  const edges = transitions
    .map((edge) => {
      const from = position(edge.from),
        to = position(edge.to);
      const probability = edge.count / Math.max(1, totals.get(edge.from));
      const curve =
        from.x === to.x
          ? `M ${from.x} ${from.y - 14} C ${from.x - 36} 4, ${to.x + 36} 4, ${to.x} ${to.y - 14}`
          : `M ${from.x} ${from.y - 14} Q ${(from.x + to.x) / 2} ${from.y - 64} ${to.x} ${to.y - 14}`;
      const labelX = (from.x + to.x) / 2;
      const labelY =
        from.x === to.x
          ? 22
          : Math.max(10, from.y - 38 - Math.abs(to.x - from.x) * 0.04);
      const confidence =
        edge.count >= 4 ? "HIGH" : edge.count >= 2 ? "MODERATE" : "LOW";
      return `<path d="${curve}"/><text class="edge-label" x="${labelX}" y="${labelY}">B${edge.from}→B${edge.to} ${(probability * 100).toFixed(0)}%</text><text class="edge-count" x="${labelX}" y="${labelY + 14}">n=${edge.count} · ${confidence}</text>`;
    })
    .join("");
  const nodes = Array.from({ length: state.scenario.bands }, (_, index) => {
    const band = index + 1,
      p = position(band);
    return `<circle cx="${p.x}" cy="${p.y}" r="14"/><text class="node-label" x="${p.x}" y="${p.y + 4}">B${band}</text>`;
  }).join("");
  renderHTML(container, `<div class="graph-confidence">GRAPH CONFIDENCE <b>${Math.round((state.graph_confidence || 0) * 100)}%</b><span>Edge probability is normalized by observed outgoing transition count. Confidence labels reflect sample count.</span></div><div class="transition-scroll"><svg viewBox="0 0 ${width} 102" role="img" aria-label="Learned cross-band transition graph">${edges}${nodes}</svg></div><p class="field-hint">Edges and confidence update from the same HIT sequence used by the scheduler.</p>`);
}

function renderObservation(state) {
  const scan = state.observations.at(-1);
  const result = query("#result");
  result.className = `result ${scan?.hit ? "hit" : scan ? "miss" : ""}`;
  result.textContent = scan
    ? `CURRENT SCAN · B${scan.band} · ${scan.start.toFixed(1)}–${scan.end.toFixed(1)} ms · dwell ${scan.dwell} ms · ${scan.observation} · truth overlap ${scan.overlap.toFixed(2)} ms${scan.informative ? " · informative" : " · non-informative window"}`
    : "Scenario initialized. The scheduled first receiver window is marked on the timeline.";

  const item = state.reasoning;
  const next = state.next_action;
  const discoveryCheck =
    item.discovery_check ||
    state.discovery.find((band) => band.band === scan?.band) ||
    {};
  const unaffected = item.unaffected_hypotheses || [];
  renderHTML(query("#reasoning"), scan
    ? `<div class="reason-chain">
      <div><b>OBSERVATION</b><span>${scan.observation} · B${scan.band} · ${scan.start.toFixed(1)}–${scan.end.toFixed(1)} ms, dwell ${scan.dwell} ms</span></div>
      <div><b>TEMPORAL OVERLAP</b><span>Model ${item.temporal_overlap.toFixed(2)} · truth ${scan.overlap.toFixed(2)} ms</span></div>
      <div><b>LIKELIHOOD</b><span>${item.likelihood == null ? "No matching hypothesis" : item.likelihood.toFixed(4)}</span></div>
      <div><b>POSTERIOR UPDATE</b><span>${item.hypothesis_id || "Band model"}: ${item.posterior_before == null ? "n/a" : item.posterior_before.toFixed(3)} → ${item.posterior_after == null ? "n/a" : item.posterior_after.toFixed(3)}</span></div>
      <div><b>EXCLUSION GAIN</b><span>${Number(item.exclusion_gain ?? 0).toFixed(4)}${unaffected.length ? ` · MISS did not affect ${unaffected.map((hypothesis) => hypothesis.id).join(", ")}` : ""}</span></div>
      <div><b>DISCOVERY CHECK</b><span>B${scan.band} age ${Number(discoveryCheck.age ?? 0).toFixed(1)} ms · risk ${Number(discoveryCheck.risk ?? 0).toFixed(2)} · prior priority ${Number(item.discovery_priority_before ?? discoveryCheck.risk ?? 0).toFixed(2)}</span></div>
      <div><b>NEXT ACTION</b><span>${next ? `B${next.band} at ${next.start.toFixed(1)} ms for ${next.dwell} ms · score ${next.score.toFixed(6)}` : "No action available"}</span></div>
    </div>`
    : `Initial model → reason → schedule. Loaded ${state.timeline.truth_windows.length} ground-truth activity windows and ${state.hypotheses.length} hypotheses. Initial decision: ${next ? `B${next.band} at ${next.start.toFixed(1)} ms, dwell ${next.dwell} ms` : "none"}.`);
}

const METHOD_INFO = [
  [
    "random",
    "Random scanning",
    "Selects available bands without learned structure.",
  ],
  [
    "sequential",
    "Sequential scanning",
    "Cycles through bands using a fixed order.",
  ],
  ["fixed_priority", "Fixed priority", "Uses predefined band priorities."],
  [
    "greedy",
    "Greedy independent scoring",
    "Selects the highest current independent score.",
  ],
  ["ucb", "UCB", "Balances estimated reward and uncertainty."],
  [
    "thompson",
    "Thompson sampling",
    "Samples actions using posterior reward distributions.",
  ],
  [
    "proposed",
    "SCAN-GRAPH",
    "Uses evidence, cross-band transition structure and confidence-guided exploration.",
  ],
];

function emptyResearchState(active) {
  for (const [id, content] of [
    ["hypothesisEmpty", "hypothesisContent"],
    ["certificateEmpty", "certificateContent"],
    ["baselineEmpty", "baselineContent"],
  ]) {
    query(`#${id}`).classList.toggle("hidden", active);
    query(`#${content}`).classList.toggle("hidden", !active);
  }
}

function hypothesisStatus(hypothesis, excludedIds) {
  if (excludedIds.has(hypothesis.id)) return "RULED OUT";
  if (Number(hypothesis.stale || 0) >= 0.5) return "STALE";
  if (hypothesis.supports?.length) return "SUPPORTED";
  if (
    hypothesis.contradictions?.length ||
    hypothesis.posterior < hypothesis.prior * 0.8
  )
    return "WEAKENED";
  return "PLAUSIBLE";
}

function renderHypothesisResearch(state) {
  const hypotheses = state.hypotheses || [];
  const excludedIds = new Set(
    state.certificate.excluded_hypotheses.map((item) => item.id),
  );
  const statuses = hypotheses.map((hypothesis) => [
    hypothesis,
    hypothesisStatus(hypothesis, excludedIds),
  ]);
  query("#hypActive").textContent = statuses.filter(
    ([, status]) => status !== "RULED OUT",
  ).length;
  query("#hypSupported").textContent = statuses.filter(
    ([, status]) => status === "SUPPORTED",
  ).length;
  query("#hypWeakened").textContent = statuses.filter(
    ([, status]) => status === "WEAKENED",
  ).length;
  query("#hypExcluded").textContent = statuses.filter(
    ([, status]) => status === "RULED OUT",
  ).length;
  if (!hypotheses.some((item) => item.id === selectedHypothesisId))
    selectedHypothesisId = hypotheses[0]?.id;
  const detailHypothesis = hypotheses.find(
    (item) => item.id === selectedHypothesisId,
  );
  const search = query("#hypSearch").value.trim().toLowerCase();
  const statusFilter = query("#hypStatusFilter").value.toUpperCase();
  const visible = statuses.filter(
    ([item, status]) =>
      `${item.id} B${item.band}`.toLowerCase().includes(search) &&
      (statusFilter === "ALL" || status === statusFilter),
  );
  visible.sort(([left], [right]) => {
    const a = left[hypothesisSort.key] ?? "";
    const b = right[hypothesisSort.key] ?? "";
    return (
      (typeof a === "number" ? a - b : String(a).localeCompare(String(b))) *
      hypothesisSort.direction
    );
  });
  const sparkline = (item) => {
    const history = item.history || [];
    const points = history
      .map(
        (point, index) =>
          `${history.length < 2 ? 50 : (index / (history.length - 1)) * 100},${100 - point.posterior * 100}`,
      )
      .join(" ");
    return `<svg class="hyp-sparkline" viewBox="0 0 100 100" role="img" aria-label="Posterior history for ${item.id}"><polyline points="${points}"/></svg>`;
  };
  const header = (key, text) =>
    `<th><button class="sort-button" type="button" data-sort="${key}">${text}</button></th>`;
  renderHTML(query("#hypTable"), visible.length
    ? `<table class="table"><thead><tr>${header("id", "ID")}${header("band", "BAND")}<th>EXPECTED ACTIVITY</th>${header("period", "PERIOD")}<th>DWELL</th><th>PRIOR</th>${header("posterior", "POSTERIOR")}<th>HISTORY</th><th>STATUS</th></tr></thead><tbody>${visible.map(([item, status]) => `<tr class="selectable-row ${item.id === selectedHypothesisId ? "is-selected" : ""}" data-hypothesis="${item.id}" tabindex="0"><td><b>${item.id}</b></td><td>B${item.band}</td><td>${item.kind === "rare" ? "Intermittent" : "Active"}</td><td>${item.period} ms</td><td>${item.width} ms</td><td>${item.prior.toFixed(3)}</td><td><b>${item.posterior.toFixed(3)}</b></td><td>${sparkline(item)}</td><td><span class="status-pill status-${status.toLowerCase().replaceAll(" ", "-")}">${status === "RULED OUT" ? "Ruled out" : status[0] + status.slice(1).toLowerCase()}</span></td></tr>`).join("")}</tbody></table>`
    : '<p class="table-empty">No hypotheses match these filters.</p>');
  query("#hypTable")
    .querySelectorAll("[data-hypothesis]")
    .forEach((row) => {
      const select = () => {
        selectedHypothesisId = row.dataset.hypothesis;
        renderHypothesisResearch(state);
      };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
    });
  query("#hypTable")
    .querySelectorAll("[data-sort]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        hypothesisSort = {
          key: button.dataset.sort,
          direction:
            hypothesisSort.key === button.dataset.sort
              ? -hypothesisSort.direction
              : 1,
        };
        renderHypothesisResearch(state);
      }),
    );
  if (!detailHypothesis) return;
  const last = [...state.observations]
    .reverse()
    .find((observation) =>
      observation.updates?.some((update) => update.id === detailHypothesis.id),
    );
  const update = last?.updates?.find((item) => item.id === detailHypothesis.id);
  const latest = last
    ? `${last.observation} at ${last.end.toFixed(1)} ms`
    : "No observation yet";
  const overlap = update ? `${(update.overlap * 100).toFixed(1)}%` : "—";
  const likelihoodText = update
    ? update.likelihood.toFixed(4)
    : "No observation evidence yet";
  const status = hypothesisStatus(detailHypothesis, excludedIds);
  renderHTML(query("#hypDetail"),
    `<h3>${detailHypothesis.id}</h3><dl><div><dt>Band</dt><dd>B${detailHypothesis.band}</dd></div><div><dt>Expected behaviour</dt><dd>${detailHypothesis.kind === "rare" ? "Intermittent" : "Periodic"}</dd></div><div><dt>Prior belief</dt><dd>${detailHypothesis.prior.toFixed(3)}</dd></div><div><dt>Latest observation</dt><dd>${latest}</dd></div><div><dt>Temporal overlap</dt><dd>${overlap}</dd></div><div><dt>Likelihood</dt><dd>${likelihoodText}</dd></div><div><dt>Posterior</dt><dd>${detailHypothesis.posterior.toFixed(4)}</dd></div><div><dt>Status</dt><dd>${status}</dd></div></dl><p>${last ? (update.overlap < 0.1 && last.observation === "MISS" ? "Non-informative MISS: this hypothesis was not expected to overlap the receiver window, so it was not penalized." : `${last.observation} evidence was evaluated against the modeled temporal overlap.`) : "Posterior remains at its prior until a receiver observation updates it."}</p>`);
  const history = detailHypothesis.history || [];
  const maxTime = Math.max(1, state.scenario.horizon);
  const points = history
    .map(
      (point) =>
        `${(point.time / maxTime) * 100},${100 - point.posterior * 100}`,
    )
    .join(" ");
  renderHTML(query("#posteriorChart"), history.length
    ? `<div class="chart-axis"><span>POSTERIOR</span><span>1.0</span></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Posterior history for ${detailHypothesis.id}"><line x1="0" y1="50" x2="100" y2="50"/><polyline points="${points}"/>${history.map((point) => `<circle cx="${(point.time / maxTime) * 100}" cy="${100 - point.posterior * 100}" r="1.5"><title>${point.time} ms: ${point.posterior.toFixed(4)}</title></circle>`).join("")}</svg><div class="chart-axis"><span>0 ms</span><span>${state.scenario.horizon} ms</span></div><p>Prior → observation → temporal overlap → likelihood → posterior update</p>`
    : "<p>Posterior history appears after observation updates.</p>");
  const logs = [...state.observations].reverse().slice(0, 12);
  renderHTML(query("#hypUpdateLog"), logs.length
    ? logs
        .map((observation) => {
          const related =
            observation.updates?.filter(
              (item) => item.band === observation.band,
            ) || [];
          const before = related.reduce((sum, item) => sum + item.prior, 0);
          const after = related.reduce((sum, item) => sum + item.posterior, 0);
          const emphasis =
            observation.observation === "HIT"
              ? "Posterior support increased"
              : observation.informative
                ? "Informative miss reduced belief"
                : "Non-informative miss; belief preserved";
          return `<article><b>${observation.end.toFixed(1)} ms · B${observation.band} · ${observation.observation}</b><span>${observation.informative ? "Temporal overlap supported an update" : "Low temporal overlap"}</span><small>${emphasis} (${before.toFixed(3)} → ${after.toFixed(3)} in-band mass)</small></article>`;
        })
        .join("")
    : "<p>No observations yet. Step Scan in the Receiver Console to build posterior history.</p>");
}

function renderEvidenceResearch(state) {
  const scenario = state.scenario;
  renderHTML(query("#certificateHeader"),
    `<article><small>EXPERIMENT</small><b>${scenario.experiment_name || scenario.name}</b></article><article><small>SCENARIO</small><b>${scenario.name}</b></article><article><small>SEED</small><b>${scenario.seed}</b></article><article><small>SIMULATION DURATION</small><b>${scenario.horizon} ms</b></article><article><small>CURRENT TIME</small><b>${state.time.toFixed(1)} ms</b></article><article><small>RECEIVER CAPACITY</small><b>${state.receiver_bandwidth_bands} band(s)</b></article>`);
  const ruledIds = new Set(
    state.certificate.excluded_hypotheses.map((item) => item.id),
  );
  const bandBars = Array.from({ length: scenario.bands }, (_, index) => {
    const band = index + 1;
    const hypotheses = state.hypotheses.filter((item) => item.band === band);
    const ruledCount = hypotheses.filter((item) =>
      ruledIds.has(item.id),
    ).length;
    const plausibleCount = hypotheses.length - ruledCount;
    const total = Math.max(1, hypotheses.length);
    return `<div class="certificate-band-row" title="B${band}: ${ruledCount} ruled out, ${plausibleCount} still plausible"><b>B${band}</b><div class="certificate-band-track"><i class="ruled-bar" style="width:${(ruledCount / total) * 100}%"></i><i class="plausible-bar" style="width:${(plausibleCount / total) * 100}%"></i></div><span>${ruledCount} ruled out · ${plausibleCount} plausible</span></div>`;
  }).join("");
  renderHTML(query("#certificateBars"),
    bandBars || "<p>No hypotheses are available for this certificate.</p>");
  const observations = state.observations || [];
  if (!observations.some((item) => item.index === selectedObservationIndex))
    selectedObservationIndex = observations.at(-1)?.index;
  renderHTML(query("#certificateTable"), observations.length
    ? `<table class="table"><thead><tr><th>STEP / TIME</th><th>BAND</th><th>START</th><th>DWELL</th><th>RESULT</th><th>SIGNAL STRENGTH</th><th>DETECTION CONFIDENCE</th><th>MODELED OVERLAP</th><th>EVIDENCE</th></tr></thead><tbody>${observations
        .map((item) => {
          const overlap = item.reasoning?.temporal_overlap ?? item.overlap;
          return `<tr class="selectable-row ${item.index === selectedObservationIndex ? "is-selected" : ""}" data-observation="${item.index}"><td>${item.index} · ${item.end.toFixed(1)} ms</td><td>B${item.band}</td><td>${item.start.toFixed(1)} ms</td><td>${item.dwell.toFixed(1)} ms</td><td>${item.observation}</td><td>${(item.signal_strength ?? 0).toFixed(3)}</td><td>${(item.detection_confidence ?? 0).toFixed(3)}</td><td>${overlap.toFixed(3)}</td><td>${overlap >= 0.4 ? "STRONG" : overlap >= 0.1 ? "MODERATE" : "WEAK"}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "<p>No receiver observations yet. Step Scan in the Receiver Console to record evidence.</p>");
  query("#certificateTable")
    .querySelectorAll("[data-observation]")
    .forEach((row) =>
      row.addEventListener("click", () => {
        selectedObservationIndex = Number(row.dataset.observation);
        renderEvidenceResearch(state);
      }),
    );
  const observation = observations.find(
    (item) => item.index === selectedObservationIndex,
  );
  if (!observation) {
    renderHTML(query("#evidenceReasoning"),
      "<p>Evidence reasoning will appear after the first receiver scan.</p>");
  } else {
    const reason = observation.reasoning || {};
    const modeledOverlap = reason.temporal_overlap ?? observation.overlap;
    const changePoint = state.scenario.emitters.find(
      (emitter) => emitter.kind === "behavior_change",
    )?.change_time;
    const repeatedObservableMisses = observations.filter(
      (item) =>
        item.band === observation.band &&
        item.observation === "MISS" &&
        (item.reasoning?.temporal_overlap || 0) >= 0.4,
    ).length;
    const missClassification =
      observation.observation !== "MISS"
        ? "Not applicable"
        : repeatedObservableMisses >= 3
          ? "Possible absence after repeated informative non-detections"
          : changePoint != null && observation.start >= changePoint
            ? "Behaviour-change MISS; reassess the previously learned transition pattern"
            : modeledOverlap < 0.1
              ? "Timing-related MISS; predicted activity did not overlap the receiver window"
              : modeledOverlap < 0.6
                ? "Timing-related MISS; only partial predicted activity overlapped"
                : "Informative MISS during a strong predicted activity window";
    const consequence =
      observation.observation === "MISS" && modeledOverlap < 0.1
        ? "Weak evidence against this band; hypotheses remain eligible for exploration."
        : observation.observation === "MISS"
          ? "Evidence against hypotheses that predicted activity during this window."
          : "Detection supports hypotheses with matching temporal overlap.";
    renderHTML(query("#evidenceReasoning"),
      `<div><b>OBSERVATION</b><span>${observation.observation} on B${observation.band} at ${observation.end.toFixed(1)} ms</span></div>${observation.observation === "MISS" ? `<div><b>MISS CLASSIFICATION</b><span>${missClassification}</span></div>` : ""}<div><b>TEMPORAL OVERLAP</b><span>${modeledOverlap.toFixed(3)} · ${modeledOverlap < 0.1 ? "Low" : modeledOverlap >= 0.4 ? "High" : "Moderate"}</span></div><div><b>LIKELIHOOD</b><span>${reason.likelihood == null ? "No matching hypothesis" : reason.likelihood.toFixed(4)}</span></div><div><b>POSTERIOR UPDATE</b><span>${reason.hypothesis_id || "Band model"}: ${reason.posterior_before == null ? "n/a" : reason.posterior_before.toFixed(4)} → ${reason.posterior_after == null ? "n/a" : reason.posterior_after.toFixed(4)}</span></div><div><b>HYPOTHESIS CONSEQUENCE</b><span>${consequence}</span></div><div><b>SCHEDULING CONSEQUENCE</b><span>${modeledOverlap < 0.1 && observation.observation === "MISS" ? "Band remains eligible for future exploration." : "Updated beliefs and transition evidence inform the next action."}</span></div>`);
  }
  const updates = observation?.updates || [];
  const ruled = updates
    .filter((item) => item.band === observation?.band && item.overlap >= 0.1)
    .sort((a, b) => a.posterior - b.posterior)
    .slice(0, 4);
  renderHTML(query("#exclusionEvidence"), observation
    ? `<p><b>${observation.observation} on B${observation.band}</b>: ${ruled.length ? "Hypotheses with predicted overlap received negative or positive evidence as shown." : "No hypotheses were expected to overlap; this scan does not rule out band activity."}</p>${ruled.map((item) => `<article class="exclusion-row"><b>${item.id} · overlap ${(item.overlap * 100).toFixed(1)}%</b><span>Evidence strength: ${item.overlap >= 0.4 ? "strong" : "moderate"}</span><small>${item.observation === "MISS" ? "MISS during predicted activity lowered its posterior." : "HIT supports this hypothesis."} ${item.prior.toFixed(3)} → ${item.posterior.toFixed(3)}</small></article>`).join("") || "<p>Remaining plausible hypotheses are preserved because the observation window did not overlap their predicted activity.</p>"}`
    : "<p>Select an observation to inspect which hypotheses it constrained.</p>");
  const action = state.next_action;
  const lastAction = state.observations.at(-1)?.selected_action;
  const reasons = action
    ? `<ul>${action.reason ? `<li>${action.reason}</li>` : ""}<li>Information gain: ${action.information_gain?.toFixed(3) ?? "not exposed"}</li><li>Transition support: ${action.transition_support?.toFixed(3) ?? "not exposed"}</li><li>Redundancy penalty: ${action.redundancy_penalty?.toFixed(3) ?? "not exposed"}</li><li>Discovery priority: ${action.discovery_priority?.toFixed(3) ?? "not exposed"}</li><li>Scheduler score: ${action.score?.toFixed(6) ?? "not exposed"}</li></ul>`
    : "<p>No next action is available; the simulation horizon is complete.</p>";
  renderHTML(query("#auditableDecision"),
    `<p>Latest completed action: ${lastAction ? `B${lastAction.band} at ${lastAction.start} ms for ${lastAction.dwell} ms` : "No scan recorded yet."}</p><h3>NEXT ACTION</h3><strong>${action ? `B${action.band} · Start ${action.start} ms · Dwell ${action.dwell} ms` : "Horizon complete"}</strong>${reasons}`);
  const plausible = [...state.hypotheses]
    .sort((a, b) => b.posterior - a.posterior)
    .slice(0, 6);
  renderHTML(query("#certificateBeliefs"),
    plausible
      .map(
        (hypothesis) =>
          `<div class="belief-state-row"><b>B${hypothesis.band} · ${hypothesis.kind === "rare" ? "Rare/intermittent" : `${hypothesis.period} ms periodic`}</b><strong>${hypothesis.posterior.toFixed(4)}</strong></div>`,
      )
      .join("") ||
    "<p>No active hypotheses are present in the experiment state.</p>");
  const informative = observations.filter((item) => item.informative).length;
  const verdict =
    informative < 3
      ? {
          name: "ABSTAIN",
          detail: `${informative} informative observation(s) recorded. There is not yet enough evidence for a stable conclusion.`,
        }
      : {
          name: "SENSITIVE",
          detail:
            "Evidence is available, but this prototype has not run a scenario-perturbation stability sweep; conclusions remain seed-conditioned.",
        };
  renderHTML(query("#certificateVerdict"),
    `<b class="verdict-${verdict.name.toLowerCase()}">${verdict.name}</b><p>${verdict.detail}</p><small>Robust status requires measured stability under perturbed conditions.</small>`);
  renderHTML(query("#decisionTrace"), observations.length
    ? [...observations]
        .map(
          (item) =>
            `<article><b>${item.index}. ${item.observation} on B${item.band} at ${item.end.toFixed(1)} ms</b><span>Temporal overlap ${(item.reasoning.temporal_overlap * 100).toFixed(1)}% → evidence ${item.informative ? "updated" : "preserved"} → posterior ${item.reasoning.posterior_before == null ? "unchanged" : `${item.reasoning.posterior_before.toFixed(3)} → ${item.reasoning.posterior_after.toFixed(3)}`}</span><small>Next scheduling decision: B${item.selected_action.band}, start ${item.selected_action.start.toFixed(1)} ms, dwell ${item.selected_action.dwell} ms.</small></article>`,
        )
        .join("")
    : "<p>Decision trace will be populated by the first Receiver Console scan.</p>");
}

function renderBaselineSetup(state) {
  const scenario = state.scenario;
  const conditions = [
    ["SCENARIO", scenario.name],
    ["SEED", scenario.seed],
    ["BANDS", scenario.bands],
    ["EMITTERS", scenario.emitters.length],
    ["SIMULATION DURATION", `${scenario.horizon} ms`],
    ["RECEIVER CAPACITY", `${state.receiver_bandwidth_bands} band(s)`],
  ];
  renderHTML(query("#baselineConditions"), conditions
    .map(
      ([label, value]) =>
        `<article><small>${label}</small><b>${value}</b></article>`,
    )
    .join(""));
  if (!query("#baselineMethods").dataset.ready) {
    renderHTML(query("#baselineMethods"), METHOD_INFO.map(
      ([id, title, description]) =>
        `<label class="method-choice"><input type="checkbox" value="${id}" checked><span><b>${title}</b><small>${description}</small></span></label>`,
    ).join(""));
    query("#baselineMethods").dataset.ready = "true";
  }
}

function renderComparison(result, scenario) {
  const labels = Object.fromEntries(
    METHOD_INFO.map(([id, title]) => [id, title]),
  );
  const cols = [
    ["useful_observations", "USEFUL OBSERVATIONS"],
    ["scans", "TOTAL SCANS"],
    ["discovery_coverage", "DISCOVERY COVERAGE"],
    ["recovery_time", "RECOVERY TIME"],
    ["exploration_overhead", "EXPLORATION"],
    ["cpu_seconds", "CPU TIME"],
  ];
  const methods = result.methods;
  const maximize = new Set(["useful_observations", "discovery_coverage"]);
  const best = Object.fromEntries(
    cols.map(([key]) => [
      key,
      Math[maximize.has(key) ? "max" : "min"](
        ...methods.map((item) => Number(item[key] ?? Infinity)),
      ),
    ]),
  );
  const valueFor = (item, key) =>
    key === "discovery_coverage"
      ? `${(item[key] * 100).toFixed(1)}%`
      : key === "recovery_time"
        ? scenario.emitters.some(
            (emitter) => emitter.kind === "behavior_change",
          )
          ? `${item[key]} ms`
          : "Not applicable"
        : key === "cpu_seconds"
          ? `${item[key].toFixed(4)} s`
          : item[key];
  const table = `<div class="table-wrap"><table class="table"><thead><tr><th>METHOD</th>${cols.map(([, name]) => `<th>${name}</th>`).join("")}</tr></thead><tbody>${methods.map((item) => `<tr><td><b>${labels[item.algorithm] || item.algorithm}</b></td>${cols.map(([key]) => `<td class="${Number(item[key]) === best[key] ? "best-value" : ""}">${valueFor(item, key)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const chartMetric = (key, title, format) =>
    `<section class="chart-card"><h3>${title}</h3>${methods
      .map((item) => {
        const maximum = Math.max(
          1,
          ...methods.map((method) => method[key] || 0),
        );
        const value = item[key] || 0;
        return `<div class="bar-row"><span>${labels[item.algorithm] || item.algorithm}</span><i><b style="width:${Math.max(1, (value / maximum) * 100)}%"></b></i><strong>${format(value)}</strong></div>`;
      })
      .join("")}</section>`;
  const graph = `<div class="comparison-charts">${chartMetric("time_to_useful_observation", "Time to useful observation", (v) => `${v} ms`)}${chartMetric("scans", "Number of scans", (v) => `${v}`)}${chartMetric("discovery_coverage", "Discovery coverage", (v) => `${(v * 100).toFixed(1)}%`)}${chartMetric("recovery_time", "Behaviour change recovery", (v) => (scenario.emitters.some((e) => e.kind === "behavior_change") ? `${v} ms` : "N/A"))}${chartMetric("exploration_overhead", "Exploration vs exploitation", (v) => `${(v * 100).toFixed(1)}%`)}${chartMetric("cpu_seconds", "CPU time", (v) => `${v.toFixed(4)} s`)}</div>`;
  const recovery = scenario.emitters.find(
    (emitter) => emitter.kind === "behavior_change",
  );
  const recoverySection = recovery
    ? `<section class="panel research-panel"><h2>Behaviour change recovery test</h2><p>Configured pattern: ${recovery.old.map((band) => `B${band}`).join(" → ")} → ${recovery.new.map((band) => `B${band}`).join(" → ")} at ${recovery.change_time} ms. Metrics are averaged over ${result.replicates} paired seed runs.</p><div class="table-wrap"><table class="table"><thead><tr><th>METHOD</th><th>OLD PATTERN CONFIDENCE</th><th>TIME TO DETECT CHANGE</th><th>EXPLORATION INCREASE</th><th>NEW TRANSITIONS DISCOVERED</th><th>RECOVERY TIME</th></tr></thead><tbody>${methods.map((item) => `<tr><td>${labels[item.algorithm] || item.algorithm}</td><td>${item.old_pattern_confidence == null ? "N/A" : (item.old_pattern_confidence * 100).toFixed(1) + "%"}</td><td>${item.time_to_detect_change == null ? "N/A" : `${item.time_to_detect_change} ms`}</td><td>${item.exploration_increase == null ? "N/A" : `${(item.exploration_increase * 100).toFixed(1)}%`}</td><td>${item.new_transitions_discovered ?? "N/A"}</td><td>${item.recovery_time} ms</td></tr>`).join("")}</tbody></table></div></section>`
    : "";
  const proposed = methods.find((item) => item.algorithm === "proposed");
  const alternatives = methods.filter((item) => item.algorithm !== "proposed");
  let interpretation =
    "The selected methods ran under paired conditions. Select at least one baseline alongside SCAN-GRAPH to assess a relative outcome.";
  if (proposed && alternatives.length) {
    const better = alternatives.filter(
      (item) =>
        proposed.time_to_useful_observation < item.time_to_useful_observation &&
        proposed.discovery_coverage >= item.discovery_coverage,
    );
    const worse = alternatives.filter(
      (item) =>
        proposed.time_to_useful_observation >=
          item.time_to_useful_observation ||
        proposed.discovery_coverage < item.discovery_coverage,
    );
    interpretation = better.length
      ? `Under this scenario and paired seed set, SCAN-GRAPH reached a useful observation sooner than ${better.length} selected baseline(s) while matching or exceeding their discovery coverage.`
      : worse.length
        ? `Under this scenario and paired seed set, the results do not show a consistent SCAN-GRAPH improvement in time to useful observation and discovery coverage.`
        : "The measured outcomes are comparable for this scenario and seed set; no clear advantage is supported.";
  }
  renderHTML(query("#experimentResults"),
    `<section class="panel research-panel"><div class="panelhead"><div><h2>Controlled comparison results</h2><p>Experiment ${result.id} · ${result.replicates} paired runs · seed ${result.seed} + paired replicate offsets</p></div></div>${table}${recoverySection}</section>${graph}<section class="panel research-panel"><h2>What does the experiment show?</h2><p class="research-callout">${interpretation}</p></section>`);
  query("#exportBaselineCsv").classList.remove("hidden");
}

function renderResearchPages(state) {
  const active =
    state.experiment_active ?? Boolean(state.scenario?.experiment_name);
  emptyResearchState(active);
  if (!active) return;
  if (comparisonScenarioId !== state.scenario.id) {
    lastComparison = null;
    comparisonScenarioId = state.scenario.id;
  }
  renderHypothesisResearch(state);
  renderEvidenceResearch(state);
  renderBaselineSetup(state);
  if (lastComparison) renderComparison(lastComparison, state.scenario);
  else
    renderHTML(query("#experimentResults"),
      '<section class="panel research-panel"><p>Run the selected schedulers to calculate a controlled comparison from this active experiment.</p></section>');
}

function render(state) {
  currentState = state;
  activeScenario = state.scenario;
  query("#clock").textContent = `${state.time.toFixed(1)} ms`;
  query("#statusScenario").textContent =
    state.scenario.name || "Current scenario";
  query("#statusSeed").textContent = state.scenario.seed;
  query("#mode").textContent = state.mode;
  const lastScan = state.observations.at(-1);
  const next = state.next_action;
  query("#consoleCurrentBand").textContent = lastScan
    ? `B${lastScan.band}`
    : next
      ? `B${next.band} (scheduled)`
      : "—";
  query("#consoleExperimentName").textContent =
    state.scenario.experiment_name || state.scenario.name;
  query("#consoleScenarioType").textContent = state.scenario.name;
  query("#consoleCurrentTime").textContent = `${state.time.toFixed(1)} ms`;
  query("#consoleNextScan").textContent = next
    ? `B${next.band} · ${next.start.toFixed(1)} ms`
    : lastScan
      ? "Horizon complete"
      : "—";
  query("#consoleSchedulerMode").textContent = state.mode;
  query("#consoleGraphConfidence").textContent =
    `${Math.round((state.graph_confidence || 0) * 100)}%`;
  query("#consoleExploreRatio").textContent =
    `${Math.round((state.exploration_ratio || 0) * 100)}% explore · ${Math.round((1 - (state.exploration_ratio || 0)) * 100)}% exploit`;
  const saved = sessionStorage.getItem("scanGraphScenario");
  if (saved) {
    try {
      const stored = JSON.parse(saved);
      if (stored.id === state.scenario.id) {
        stored.completed_steps = state.observations.length;
        sessionStorage.setItem("scanGraphScenario", JSON.stringify(stored));
      }
    } catch {
      /* ignore invalid session cache */
    }
  }
  renderSpectrum(state);
  renderCandidates(state);
  renderBeliefs(state);
  renderDiscovery(state);
  renderObservation(state);
  renderHTML(query("#events"), state.events.length
    ? state.events
        .map(
          (event) =>
            `<p><b>t=${event.time.toFixed(1)} ms · ${event.type.replaceAll("_", " ")}</b><br>${event.message}${event.decayed_hypotheses ? `<br>Confidence/evidence decay applied to ${event.decayed_hypotheses} hypotheses; learned ${event.new_hypothesis || "new transition evidence"}.` : ""}</p>`,
        )
        .join("")
    : "No surprise detected. Evidence is accumulated from receiver scans.");
  query("#changeStatus").textContent = state.events.some(
    (event) => event.type === "BEHAVIOUR_CHANGE_DETECTED",
  )
    ? "BEHAVIOUR CHANGE DETECTED · recovery and exploration are active"
    : state.timeline.change_points.length
      ? `Configured ground-truth change at ${state.timeline.change_points[0].time} ms · awaiting receiver evidence`
      : "No configured behavior change in this scenario";
  query("#transitions").textContent = state.transitions.length
    ? state.transitions
        .map((item) => `B${item.from} → B${item.to}: ${item.count}`)
        .join(" · ")
    : "No hit transitions learned yet.";
  renderTransitionGraph(state);
  renderResearchPages(state);
}

function showRequestError(target, error) {
  const element = typeof target === "string" ? query(target) : target;
  element.textContent = localMode
    ? `LOCAL SIMULATION ERROR · ${error.message}`
    : `BACKEND REQUEST ERROR · ${error.message}`;
  element.classList.add("miss");
  element.classList.remove("hidden");
}

async function refresh() {
  try {
    render(await request("/simulation/state"));
  } catch (error) {
    showRequestError("#result", error);
  }
}
async function stepScan() {
  try {
    const state = await request("/simulation/step", { algorithm: "proposed" });
    render(state);
    return state;
  } catch (error) {
    showRequestError("#result", error);
    return null;
  }
}
async function resetSimulation() {
  try {
    render(await request("/simulation/reset", {}));
  } catch (error) {
    showRequestError("#result", error);
  }
}

let previewTimer = null;
let previewSerial = 0;

function selectedScenarioType() {
  return document.querySelector('input[name="scenarioType"]:checked').value;
}

function bandOptionMarkup(count, selected) {
  return Array.from({ length: count }, (_, index) => index + 1)
    .map(
      (band) =>
        `<option value="${band}"${selected.includes(band) ? " selected" : ""}>B${band}</option>`,
    )
    .join("");
}

function refreshBandOptions() {
  const count = Math.max(3, Number(query("#bandCount").value) || 10);
  const fill = (selector, fallback) => {
    const element = query(selector);
    const current = Number(element.value) || fallback;
    const selected = Math.min(count, current);
    element.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const band = index + 1;
      return new Option(`B${band}`, String(band), false, band === selected);
    }));
    element.value = String(selected);
  };
  fill("#periodicBand", 2);
  fill("#dutyBand", 2);
  fill("#rareBand", 7);
  fill("#agileStart", 2);
  fill("#initialBand", 2);
  const agile = query("#agileBands");
  const selected = agile.options.length
    ? [...agile.selectedOptions].map((option) => Number(option.value))
    : [2, 4, 6, 8];
  const selectedSet = new Set(selected.map((band) => Math.min(count, band)));
  agile.replaceChildren(...Array.from({ length: count }, (_, index) => {
    const band = index + 1;
    return new Option(`B${band}`, String(band), false, selectedSet.has(band));
  }));
  if (![...agile.selectedOptions].length && agile.options.length)
    agile.options[0].selected = true;
  const selectedBands = new Set(
    [...agile.selectedOptions].map((option) => Number(option.value)),
  );
  query("#agileBandChips").replaceChildren(
    ...Array.from({ length: count }, (_, index) => {
      const band = index + 1;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "band-chip";
      chip.textContent = `B${band}`;
      chip.setAttribute("aria-pressed", String(selectedBands.has(band)));
      chip.addEventListener("click", () => {
        const option = [...agile.options].find(
          (item) => Number(item.value) === band,
        );
        if (!option) return;
        option.selected = !option.selected;
        chip.setAttribute("aria-pressed", String(option.selected));
        chip.classList.toggle("is-selected", option.selected);
        updateScenarioPreview();
      });
      chip.classList.toggle("is-selected", selectedBands.has(band));
      return chip;
    }),
  );
  query("#receiverCapacity").max = String(count);
  query("#periodicStart").max = query("#duration").value;
  query("#dutyStart").max = query("#duration").value;
}

function updateSelection() {
  const type = selectedScenarioType();
  const ids = {
    Periodic: "periodic",
    "Duty-Cycled": "duty",
    "Frequency Agile": "agile",
    "Rare Emitter": "rare",
    "Behaviour Change": "change",
  };
  document.querySelectorAll(".scenario-choice").forEach((card) => {
    const selected = card.querySelector("input").checked;
    card.classList.toggle("selected", selected);
    card.querySelector(".selection-indicator").textContent = selected
      ? "SELECTED"
      : "SELECT";
  });
  document.querySelectorAll(".type-config").forEach((panel) => {
    const visible = panel.id === `config-${ids[type]}`;
    panel.classList.toggle("hidden", !visible);
    panel.querySelectorAll("input,select").forEach((input) => {
      if (input.dataset.wasRequired === undefined)
        input.dataset.wasRequired = input.required ? "true" : "false";
      input.required = visible && input.dataset.wasRequired === "true";
    });
  });
  const pattern =
    document.querySelector('input[name="hopPattern"]:checked')?.value ||
    "sequential";
  query("#customSequenceWrap").classList.toggle(
    "hidden",
    pattern !== "custom" || type !== "Frequency Agile",
  );
  query("#previewScenarioLabel").textContent = type.toUpperCase();
  updateScenarioPreview();
}

function scenarioFromForm() {
  const type = selectedScenarioType();
  const bands = Number(query("#bandCount").value);
  const duration = Number(query("#duration").value);
  const count = Number(query("#emitterCount").value);
  const seed = Number(query("#configSeed").value);
  const selected = [...query("#agileBands").selectedOptions].map((option) =>
    Number(option.value),
  );
  const startBand = Number(query("#agileStart").value);
  let customBands = (query("#customSequence").value.match(/\d+/g) || []).map(
    Number,
  );
  const hopPattern =
    document.querySelector('input[name="hopPattern"]:checked')?.value ||
    "sequential";
  if (hopPattern === "custom" && customBands.length) {
    customBands = customBands.map((band) => Math.min(bands, Math.max(1, band)));
    if (customBands[0] !== startBand) customBands.unshift(startBand);
  }
  const changeTime = Number(query("#changePoint").value);
  const initial = [Number(query("#initialBand").value) || 2, 6, 9].map((band) =>
    Math.min(band, bands),
  );
  const changed = [2, 4, 8].map((band) => Math.min(band, bands));
  const kind =
    type === "Behaviour Change"
      ? "behavior_change"
      : type === "Frequency Agile"
        ? "agile"
        : type === "Rare Emitter"
          ? "rare"
          : type === "Duty-Cycled"
            ? "duty"
            : "periodic";
  const periodicBand = Number(query("#periodicBand").value);
  const dutyPeriod = Number(query("#dutyPeriod").value);
  const rareProbability = Number(query("#rareProbability").value) / 100;
  let primary = {
    id: "E1",
    kind,
    period: 20,
    width: 5,
    phase: 0,
    band: periodicBand,
    probability: 0.3,
    label: type,
  };
  if (type === "Periodic")
    Object.assign(primary, {
      band: periodicBand,
      period: Number(query("#periodicPeriod").value),
      width: Number(query("#periodicDwell").value),
      phase: Number(query("#periodicStart").value),
    });
  if (type === "Duty-Cycled")
    Object.assign(primary, {
      band: Number(query("#dutyBand").value),
      period: dutyPeriod,
      width: Number(query("#dutyDwell").value),
      phase: Number(query("#dutyStart").value),
      duty_cycle: Number(query("#dutyPercent").value) / 100,
    });
  if (type === "Frequency Agile") {
    const available = selected.length ? selected : [startBand];
    const sequence =
      hopPattern === "custom" && customBands.length
        ? customBands
        : [startBand, ...available.filter((band) => band !== startBand)];
    Object.assign(primary, {
      period: Number(query("#agileInterval").value),
      width: Math.min(5, Number(query("#agileInterval").value)),
      phase: 0,
      bands: sequence,
      hop_pattern: hopPattern,
      seed,
    });
  }
  if (type === "Rare Emitter") {
    const expected = Number(query("#rareExpected").value);
    const windowMs = Number(query("#rareWindow").value);
    const probability = rareProbability;
    Object.assign(primary, {
      band: Number(query("#rareBand").value),
      probability,
      period: Math.max(1, (windowMs * probability) / expected),
      width: Math.min(
        2,
        Number((query("#rareWindow").value * probability) / expected),
      ),
      phase: 0,
      expected_events: expected,
    });
  }
  if (type === "Behaviour Change")
    Object.assign(primary, {
      old: initial,
      new: changed,
      change_time: changeTime,
      period: Number(query("#changeOldPeriod").value),
      old_period: Number(query("#changeOldPeriod").value),
      new_period: Number(query("#changeNewPeriod").value),
      width: Number(query("#changeOldDwell").value),
      old_width: Number(query("#changeOldDwell").value),
      new_width: Number(query("#changeNewDwell").value),
    });
  primary.seed = seed;
  const emitters = [primary];
  for (let index = 1; index < count; index += 1)
    emitters.push({
      id: `E${index + 1}`,
      kind: "periodic",
      band: (index % bands) + 1,
      period: 18 + (index % 4) * 4,
      phase: index * 2,
      width: 4,
      label: `Emitter ${index + 1}`,
    });
  return {
    id: `SCN-${seed}-${Date.now()}`,
    name: type,
    experiment_name: query("#experimentName").value.trim(),
    seed,
    time_slots: Number(query("#timeSlots").value),
    initial_band: Number(query("#initialBand").value),
    evidence_decay_rate: Number(query("#evidenceDecayRate").value),
    horizon:
      type === "Rare Emitter" ? Number(query("#rareWindow").value) : duration,
    bands,
    receiver_bandwidth_mhz: 10,
    receiver_bandwidth_bands: Number(query("#receiverCapacity").value),
    min_dwell_ms: Number(query("#minDwell").value),
    max_dwell_ms: Number(query("#maxDwell").value),
    noise_level: Number(query("#noiseLevel").value),
    false_alarm_probability: Number(query("#falseAlarm").value),
    exploration_threshold: Number(query("#explorationThreshold").value),
    exploration_rate: Number(query("#explorationRate").value),
    confidence_threshold: Number(query("#confidenceThreshold").value),
    emitters,
  };
}

function renderBackendTimeline(timeline, nextAction, scenario) {
  const horizon = timeline.horizon;
  const values = Array.from({ length: 11 }, (_, index) =>
    Math.round((horizon * index) / 10),
  );
  const ticks = values
    .map(
      (value, index) =>
        `<span>${value}${index === 0 || index === values.length - 1 ? " ms" : ""}</span>`,
    )
    .join("");
  const changes = timeline.change_points || [];
  const rows = Array.from(
    { length: scenario.bands },
    (_, index) => scenario.bands - index,
  )
    .map((band) => {
      const expected = timeline.truth_windows
        .filter((item) => item.band === band)
        .map(
          (item) =>
            `<i class="preview-activity" style="left:${(item.start / horizon) * 100}%;width:${Math.max(0.5, ((item.end - item.start) / horizon) * 100)}%" title="${item.emitter}: expected activity"></i>`,
        )
        .join("");
      const scan =
        nextAction?.band === band
          ? `<i class="preview-scan-window" style="left:${(nextAction.start / horizon) * 100}%;width:${Math.max(0.5, (nextAction.dwell / horizon) * 100)}%" title="Scheduled receiver scan"></i>`
          : "";
      const marker = changes
        .map(
          (point) =>
            `<i class="preview-change-line" style="left:${(point.time / horizon) * 100}%" title="Behaviour change at ${point.time} ms"></i>`,
        )
        .join("");
      return `<div class="preview-band-row"><b>B${band}</b><div class="preview-track">${expected}${scan}${marker}</div></div>`;
    })
    .join("");
  renderHTML(query("#scenarioPreview"),
    `<div class="preview-axis"><b>TIME</b><div class="preview-axis-line">${ticks}</div></div>${rows}${timeline.truth_windows.length ? "" : '<p class="no-events">NO ACTIVITY WINDOWS IN THIS SIMULATION HORIZON</p>'}`);
  query("#previewScenarioLabel").textContent = scenario.name.toUpperCase();
}

function updateSummary(scenario) {
  const type = scenario.name;
  const emitter = scenario.emitters[0];
  const arrow = "\u2192";
  const dot = "\u00b7";
  const format = (values) =>
    values.map((band) => `B${band}`).join(` ${arrow} `);
  const oldPattern = emitter.old
    ? format(emitter.old)
    : type === "Frequency Agile"
      ? format(emitter.bands)
      : `B${emitter.band}`;
  const newPattern = emitter.new
    ? format(emitter.new)
    : type === "Frequency Agile"
      ? `${emitter.hop_pattern.toUpperCase()} / ${emitter.period} ms hops`
      : type === "Rare Emitter"
        ? `${Math.round(emitter.probability * 100)}% probability`
        : type === "Duty-Cycled"
          ? `${Math.round(emitter.duty_cycle * 100)}%`
          : `${emitter.width} ms`;
  const isChange = type === "Behaviour Change";
  const isRare = type === "Rare Emitter";
  const isAgile = type === "Frequency Agile";
  const detail =
    type === "Periodic"
      ? `${emitter.period} ms period ${dot} ${emitter.width} ms active ${dot} starts at ${emitter.phase} ms`
      : type === "Duty-Cycled"
        ? `${emitter.period} ms cycle ${dot} ${emitter.width} ms active ${dot} ${Math.round(emitter.duty_cycle * 100)}% duty`
        : type === "Frequency Agile"
          ? `${emitter.hop_pattern} hopping ${dot} ${emitter.period} ms per hop`
          : type === "Rare Emitter"
            ? `${Math.round(emitter.probability * 100)}% activity probability ${dot} ${emitter.expected_events} expected event(s)`
            : `${emitter.old_period}/${emitter.old_width} ms initial ${dot} ${emitter.new_period}/${emitter.new_width} ms after ${emitter.change_time} ms`;
  query("#summaryName").textContent = scenario.experiment_name;
  query("#summarySeed").textContent = scenario.seed;
  query("#summaryNoise").textContent = scenario.noise_level;
  query("#summaryFalseAlarm").textContent = scenario.false_alarm_probability;
  query("#summaryDwellRange").textContent =
    `${scenario.min_dwell_ms}–${scenario.max_dwell_ms} ms`;
  query("#summaryThresholds").textContent =
    `${scenario.exploration_threshold} / ${scenario.confidence_threshold}`;
  query("#summaryDetail").textContent = detail;
  for (const id of ["summaryInitialRow", "summaryChangeRow", "summaryNewRow"])
    query(`#${id}`).classList.toggle(
      "hidden",
      !isChange && !isRare && !isAgile,
    );
  query("#summaryInitialTitle").textContent = isChange
    ? "Initial Pattern"
    : isRare
      ? "Target Band"
      : isAgile
        ? "Hop Sequence"
        : "Emitter Band";
  query("#summaryChangeTitle").textContent = isChange
    ? "Change Point"
    : isRare
      ? "Expected Events"
      : isAgile
        ? "Hop Interval"
        : type === "Duty-Cycled"
          ? "Cycle Period"
          : "Period";
  query("#summaryNewTitle").textContent = isChange
    ? "New Pattern"
    : isRare
      ? "Discovery Priority"
      : isAgile
        ? "Hop Pattern"
        : type === "Duty-Cycled"
          ? "Duty Cycle"
          : "Active Duration";
  query("#summaryScenario").textContent = type;
  query("#summaryBands").textContent = scenario.bands;
  query("#summaryEmitters").textContent = scenario.emitters.length;
  query("#summaryCapacity").textContent =
    `${scenario.receiver_bandwidth_bands} band${scenario.receiver_bandwidth_bands === 1 ? "" : "s"}`;
  query("#summaryDuration").textContent = `${scenario.horizon} ms`;
  query("#summaryInitial").textContent = oldPattern;
  query("#summaryChange").textContent = isChange
    ? `${emitter.change_time} ms`
    : isRare
      ? String(emitter.expected_events)
      : isAgile
        ? `${emitter.period} ms`
        : `${emitter.period} ms`;
  query("#summaryNew").textContent = isRare ? "HIGH" : newPattern;
  query("#previewInitialPattern").textContent = oldPattern;
  query("#previewNewPattern").textContent = newPattern;
  query("#previewChangeTime").textContent =
    emitter.change_time == null
      ? "No change configured"
      : `${emitter.change_time} ms`;
  query("#previewPatterns").classList.toggle("hidden", !isChange);
  if (type === "Periodic")
    query("#periodicSequence").textContent = Array.from(
      { length: 4 },
      () => `B${emitter.band}`,
    ).join(` ${arrow} `);
  if (isAgile)
    renderHTML(query("#agileExample"),
      `HOP SEQUENCE <b>${emitter.bands.map((band) => `B${band}`).join(` ${arrow} `)}</b>`);
  if (isRare)
    query("#rareEventLabel").textContent = `B${emitter.band} ${arrow} ACTIVE`;
}

function updateScenarioPreview() {
  query("#scenarioError").classList.add("hidden");
  query("#scenarioError").classList.remove("success-message");
  if (!query("#scenarioForm").checkValidity()) return;
  let scenario;
  try {
    scenario = scenarioFromForm();
  } catch {
    return;
  }
  updateSummary(scenario);
  const serial = ++previewSerial;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const result = await request("/simulation/preview", { scenario });
      if (serial === previewSerial)
        renderBackendTimeline(
          result.timeline,
          result.next_action,
          result.scenario,
        );
    } catch {
      if (serial === previewSerial)
        query("#scenarioPreview").textContent =
          "Unable to generate the timeline. Start the SCAN-GRAPH backend and try again.";
    }
  }, 180);
}

function validateScenario() {
  const form = query("#scenarioForm");
  const error = query("#scenarioError");
  error.classList.add("hidden");
  if (!form.reportValidity()) return null;
  const scenario = scenarioFromForm();
  const type = scenario.name;
  if (
    scenario.min_dwell_ms > scenario.max_dwell_ms ||
    scenario.max_dwell_ms > scenario.horizon
  ) {
    error.textContent =
      "Dwell times must be ordered and fit inside the observation window.";
    error.classList.remove("hidden");
    return null;
  }
  if (
    type === "Behaviour Change" &&
    scenario.emitters[0].change_time >= scenario.horizon
  ) {
    error.textContent =
      "Change point must be earlier than the end of the observation window.";
    error.classList.remove("hidden");
    return null;
  }
  const emitter = scenario.emitters[0];
  if (
    type === "Periodic" &&
    (emitter.width > emitter.period || emitter.phase >= scenario.horizon)
  ) {
    error.textContent =
      "Periodic active duration must fit its period, and start time must fall inside the observation window.";
    error.classList.remove("hidden");
    return null;
  }
  if (type === "Duty-Cycled" && emitter.width > emitter.period) {
    error.textContent =
      "Duty-cycled active duration must be shorter than its cycle period.";
    error.classList.remove("hidden");
    return null;
  }
  if (
    type === "Behaviour Change" &&
    (emitter.old_width > emitter.old_period ||
      emitter.new_width > emitter.new_period)
  ) {
    error.textContent = "Each behaviour dwell must fit inside its own period.";
    error.classList.remove("hidden");
    return null;
  }
  if (type === "Frequency Agile") {
    const bands = scenario.emitters[0].bands;
    if (
      bands.length < 2 ||
      bands.some((band) => band < 1 || band > scenario.bands)
    ) {
      error.textContent =
        "Choose at least two available bands for the agile emitter.";
      error.classList.remove("hidden");
      return null;
    }
    const pattern = document.querySelector(
      'input[name="hopPattern"]:checked',
    ).value;
    const selected = [...query("#agileBands").selectedOptions].map((option) =>
      Number(option.value),
    );
    if (
      pattern === "custom" &&
      (!query("#customSequence").value.trim() ||
        bands.length < 2 ||
        bands.some((band) => !selected.includes(band)))
    ) {
      error.textContent =
        "The custom hop sequence must use at least two of the selected available bands.";
      error.classList.remove("hidden");
      return null;
    }
  }
  return scenario;
}

async function persistScenario(scenario) {
  await request("/scenarios", { scenario });
  return request("/simulation/preview", { scenario });
}

async function generatePreview() {
  const scenario = validateScenario();
  if (!scenario) return;
  const button = query("#generatePreview");
  button.disabled = true;
  try {
    const preview = await persistScenario(scenario);
    renderBackendTimeline(preview.timeline, preview.next_action, scenario);
    updateSummary(scenario);
    generatedScenario = scenario;
    query("#generatedId").textContent = scenario.id;
    query("#generatedBands").textContent = scenario.bands;
    query("#generatedEmitters").textContent = scenario.emitters.length;
    query("#generatedHorizon").textContent = `${scenario.horizon} ms`;
    query("#generatedTimeSlots").textContent = scenario.time_slots;
    query("#generatedBehaviour").textContent =
      `${scenario.name}: ${scenario.emitters.map((emitter) => (emitter.kind === "behavior_change" ? `${emitter.old.map((band) => `B${band}`).join(" → ")} → ${emitter.new.map((band) => `B${band}`).join(" → ")}` : emitter.kind)).join("; ")}`;
    query("#generatedChangePoint").textContent =
      scenario.emitters.find((emitter) => emitter.kind === "behavior_change")
        ?.change_time == null
        ? "Not configured"
        : `${scenario.emitters.find((emitter) => emitter.kind === "behavior_change").change_time} ms`;
    query("#generatedSeed").textContent = scenario.seed;
    query("#generatedScenarioSummary").classList.remove("hidden");
    sessionStorage.setItem(
      "scanGraphGeneratedScenario",
      JSON.stringify(scenario),
    );
    query("#scenarioError").textContent =
      `Scenario ${scenario.id} generated. Review the timeline, then start the experiment when ready.`;
    query("#scenarioError").classList.remove("hidden");
    query("#scenarioError").classList.add("success-message");
  } catch (error) {
    query("#scenarioError").textContent =
      `Scenario generation failed: ${error.message}`;
    query("#scenarioError").classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
}

async function generateExperiment(event) {
  event.preventDefault();
  const scenario = generatedScenario || validateScenario();
  if (!scenario) return;
  const button = query("#generateScenario");
  button.disabled = true;
  query("#generatePreview").disabled = true;
  button.textContent = "Starting experiment...";
  try {
    await request("/scenarios", { scenario });
    const state = await request("/simulation/start", { scenario });
    sessionStorage.setItem(
      "scanGraphScenario",
      JSON.stringify({ ...scenario, completed_steps: 0 }),
    );
    render(state);
    showTab(query('.nav-item[data-tab="console"]'));
  } catch (error) {
    query("#scenarioError").textContent =
      `Experiment could not be started: ${error.message}`;
    query("#scenarioError").classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Start Experiment →";
    query("#generatePreview").disabled = false;
  }
}

function resetConfiguration() {
  query("#scenarioForm").reset();
  refreshBandOptions();
  query("#periodicBand").value = "2";
  query("#dutyBand").value = "2";
  query("#rareBand").value = String(
    Math.min(7, Number(query("#bandCount").value)),
  );
  query("#agileStart").value = "2";
  for (const option of query("#agileBands").options)
    option.selected = [2, 4, 6, 8].includes(Number(option.value));
  syncChangePointLimit();
  query("#receiverBands").value = query("#bandCount").value;
  query("#rareWindow").value = query("#duration").value;
  query("#dutyPercent").value = String(
    Math.round(
      (Number(query("#dutyDwell").value) / Number(query("#dutyPeriod").value)) *
        100,
    ),
  );
  query("#minDwell").max = "10";
  query("#maxDwell").min = "1";
  query("#scenarioError").classList.add("hidden");
  query("#scenarioError").classList.remove("success-message");
  sessionStorage.removeItem("scanGraphScenario");
  sessionStorage.removeItem("scanGraphGeneratedScenario");
  generatedScenario = null;
  query("#generatedScenarioSummary").classList.add("hidden");
  document.querySelector(
    'input[name="scenarioType"][value="Behaviour Change"]',
  ).checked = true;
  updateSelection();
}

function syncChangePointLimit() {
  const latest = Math.max(1, Number(query("#duration").value) - 1);
  query("#changePoint").max = latest;
  if (Number(query("#changePoint").value) > latest)
    query("#changePoint").value = latest;
}

async function loadSavedExperiment() {
  const saved = sessionStorage.getItem("scanGraphScenario");
  if (!saved) {
    showTab(query('.nav-item[data-tab="scenario"]'));
    return;
  }
  try {
    const scenario = JSON.parse(saved);
    let state = await request("/simulation/start", { scenario });
    for (let index = 0; index < (scenario.completed_steps || 0); index += 1)
      state = await request("/simulation/step", { algorithm: "proposed" });
    render(state);
    showTab(query('.nav-item[data-tab="console"]'));
  } catch (error) {
    showTab(query('.nav-item[data-tab="scenario"]'));
    query("#scenarioError").textContent =
      `Saved experiment could not be loaded: ${error.message}`;
    query("#scenarioError").classList.remove("hidden");
  }
}

async function runTenSteps() {
  if (runLoop) return;
  runLoop = true;
  query("#pause").disabled = false;
  for (
    let step = 0;
    step < 10 &&
    runLoop &&
    currentState?.time < currentState?.scenario?.horizon;
    step += 1
  ) {
    await stepScan();
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  runLoop = false;
  query("#pause").disabled = true;
}

function showTab(button) {
  const requested = button.dataset.tab;
  const implemented = [
    "home",
    "scenario",
    "console",
    "hypotheses",
    "certificate",
    "experiments",
  ];
  if (!implemented.includes(requested)) return;
  document.querySelectorAll(".nav-item").forEach((item) => {
    const selected = item.dataset.tab === requested;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  document
    .querySelectorAll(".view")
    .forEach((view) => view.classList.add("hidden"));
  query(`#${requested}`).classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setWizardStep(step) {
  const nextStep = Math.min(3, Math.max(1, Number(step)));
  query("#scenarioForm").dataset.step = String(nextStep);
  document.querySelectorAll(".wizard-step").forEach((button) => {
    const selected = Number(button.dataset.wizardStep) === nextStep;
    button.classList.toggle("is-current", selected);
    if (selected) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === "light";
  query("#themeToggle").setAttribute(
    "aria-label",
    light ? "Switch to dark theme" : "Switch to light theme",
  );
  query("#themeToggle").title = light
    ? "Switch to dark theme"
    : "Switch to light theme";
}

function delayForSpeed() {
  return Math.max(90, 1050 / speedMultiplier);
}

function setRunControls(running) {
  query("#autoRun").textContent = running ? "Running" : "Play";
  query("#autoRun").setAttribute("aria-pressed", String(running));
  query("#pause").disabled = !running;
}

async function runAutoScan() {
  if (runLoop) return;
  runLoop = true;
  setRunControls(true);
  while (runLoop && currentState?.time < currentState?.scenario?.horizon) {
    if (!(await stepScan())) break;
    await new Promise((resolve) => window.setTimeout(resolve, delayForSpeed()));
  }
  runLoop = false;
  setRunControls(false);
}

function setGuidedMoment(stage, label, callout) {
  guidedStage = stage;
  query("#guidedStepLabel").textContent = label;
  query("#guidedStepCount").textContent = `${Math.min(stage + 1, 3)} / 3`;
  query("#guidedCallout").textContent = callout;
}

async function runGuidedUntilMoment() {
  if (runLoop) return;
  runLoop = true;
  setRunControls(true);
  while (runLoop && currentState?.time < currentState?.scenario?.horizon) {
    const state = await stepScan();
    if (!state) break;
    const observation = state.observations.at(-1);
    const unaffected =
      observation?.reasoning?.unaffected_hypotheses ||
      observation?.unaffected_hypotheses ||
      [];
    const preserved = unaffected.find(
      (item) =>
        item.overlap < 0.1 && Math.abs(item.posterior - item.prior) < 1e-9,
    );
    if (
      guidedStage === 0 &&
      observation?.observation === "MISS" &&
      (preserved || !observation.informative)
    ) {
      const detail = preserved
        ? `The ${observation.dwell} ms dwell did not overlap ${preserved.id}'s predicted activity window, so its posterior stayed at ${preserved.posterior.toFixed(3)}. Other overlapping hypotheses can still be updated.`
        : `The ${observation.dwell} ms dwell did not overlap predicted activity, so this observation does not count against that hypothesis.`;
      setGuidedMoment(
        1,
        "A MISS without a penalty",
        `MISS on B${observation.band}: ${detail}`,
      );
      runLoop = false;
      break;
    }
    const changeEvent = state.events?.find(
      (event) => event.type === "BEHAVIOUR_CHANGE_DETECTED",
    );
    if (guidedStage === 1 && changeEvent) {
      setGuidedMoment(
        2,
        "Surprise at 40 ms",
        `At the 40 ms behaviour change, ${changeEvent.message} Stale evidence decays and recovery exploration increases.`,
      );
      runLoop = false;
      break;
    }
    if (state.time >= state.scenario.horizon || !state.next_action) {
      setGuidedMoment(
        3,
        "Evidence certificate",
        "The observation horizon is complete. Open the certificate to compare what the evidence ruled out with what remains plausible.",
      );
      showTab(query('.nav-item[data-tab="certificate"]'));
      runLoop = false;
      break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, delayForSpeed()));
  }
  runLoop = false;
  setRunControls(false);
}

async function startGuidedDemo() {
  resetConfiguration();
  query("#configSeed").value = "7";
  query("#emitterCount").value = "2";
  query("#changePoint").value = "40";
  query("#changeOldPeriod").value = "12";
  query("#changeNewPeriod").value = "12";
  query('input[name="scenarioType"][value="Behaviour Change"]').checked = true;
  updateSelection();
  const scenario = {
    id: "SCN-BC-01",
    name: "Behaviour Change",
    seed: 7,
    horizon: 100,
    bands: 10,
    receiver_bandwidth_mhz: 10,
    emitters: [
      {
        id: "E1",
        kind: "behavior_change",
        old: [2, 6, 9],
        new: [2, 4, 8],
        change_time: 40,
        period: 12,
        width: 5,
        label: "Agile transmitter",
      },
      {
        id: "E2",
        kind: "rare",
        band: 8,
        period: 20,
        phase: 3,
        width: 3,
        probability: 0.12,
        label: "Rare beacon",
      },
    ],
  };
  guidedStage = 0;
  guidedActive = true;
  query("#guidedDemo").classList.remove("hidden", "in-certificate");
  setGuidedMoment(
    0,
    "Starting the experiment",
    "Behaviour Change · seed 7 · change point 40 ms.",
  );
  try {
    await request("/scenarios", { scenario });
    const state = await request("/simulation/start", { scenario });
    sessionStorage.setItem(
      "scanGraphScenario",
      JSON.stringify({ ...scenario, completed_steps: 0 }),
    );
    render(state);
    showTab(query('.nav-item[data-tab="console"]'));
    runGuidedUntilMoment();
  } catch (error) {
    guidedActive = false;
    showTab(query('.nav-item[data-tab="scenario"]'));
    query("#scenarioError").textContent =
      `Guided demo could not start: ${error.message}`;
    query("#scenarioError").classList.remove("hidden");
  }
}

function exportCertificate() {
  const payload = {
    experiment: currentState.scenario,
    current_time: currentState.time,
    receiver_capacity_bands: currentState.receiver_bandwidth_bands,
    observations: currentState.observations,
    hypotheses: currentState.hypotheses,
    certificate: currentState.certificate,
    transitions: currentState.transitions,
    scheduler_decisions: currentState.certificate.scheduler_decisions,
    next_action: currentState.next_action,
  };
  const file = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `${currentState.scenario.id}-exclusion-certificate.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function retryBackend() {
  const badge = query("#backendMode");
  badge.disabled = true;
  badge.textContent = "CHECKING API…";
  const post = async (path, body) => {
    const response = await apiFetch(new URL(path, API_BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error || `${response.status} ${response.statusText}`,
      );
    return data;
  };
  try {
    const healthResponse = await apiFetch(new URL("/api/health", API_BASE));
    if (!healthResponse.ok)
      throw new Error(`API returned ${healthResponse.status}`);
    let state;
    if (localSimulation?.active) {
      state = await post("/api/experiments/start", {
        scenario: localSimulation.scenario,
      });
      activeExperimentId = state.experiment_id;
      localStorage.setItem("scanGraphExperimentId", activeExperimentId);
      for (
        let index = 0;
        index < localSimulation.observations.length;
        index += 1
      )
        state = await post(
          `/api/experiments/${encodeURIComponent(activeExperimentId)}/step`,
          { algorithm: "proposed" },
        );
      sessionStorage.removeItem("scanGraphLocalSimulation");
      localSimulation = null;
    } else {
      const statePath = activeExperimentId
        ? `/api/experiments/${encodeURIComponent(activeExperimentId)}`
        : "/api/state";
      state = await apiFetch(new URL(statePath, API_BASE)).then((response) =>
        response.json(),
      );
    }
    forceBackend = false;
    setBackendMode(false);
    render(state);
  } catch (error) {
    setLocalSimulationMode(error);
    showRequestToast(`Backend retry failed: ${error.message}`);
  } finally {
    badge.disabled = false;
  }
}

function renderExperiment(result) {
  const columns = [
    ["algorithm", "POLICY"],
    ["detection_rate", "DETECTION"],
    ["useful_hit_rate", "USEFUL HIT"],
    ["scans", "SCANS"],
    ["bands_scanned", "BANDS"],
    ["time_to_useful_observation", "TIME TO HIT"],
    ["discovery_delay", "DISCOVERY DELAY"],
    ["rare_emitter_discovery_time", "RARE HIT"],
    ["adaptation_time_after_change", "ADAPTATION"],
    ["exploration_overhead", "EXPLORE %"],
    ["cpu_seconds", "CPU S"],
    ["memory_peak_kb", "MEM KB"],
    ["cumulative_reward", "REWARD"],
  ];
  const headings = columns.map((column) => `<th>${column[1]}</th>`).join("");
  const rows = result.methods
    .map(
      (method) =>
        `<tr>${columns.map((column) => `<td>${method[column[0]]}</td>`).join("")}</tr>`,
    )
    .join("");
  renderHTML(query("#experimentResults"),
    `<div>Experiment ${result.id} · ${result.replicates} paired seed runs</div><div style="overflow:auto"><table class="table"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table></div>`);
}

async function runExperiment(button) {
  button.disabled = true;
  button.textContent = "Running controlled comparison…";
  const progress = query("#baselineProgress");
  const progressBar = query("#baselineProgressBar");
  const startedAt = performance.now();
  const estimateMs = Math.max(
    5000,
    query("#baselineMethods").querySelectorAll("input:checked").length * 5000,
  );
  progress.classList.remove("hidden");
  query("#baselineEta").textContent =
    `Estimated time: about ${Math.ceil(estimateMs / 1000)} seconds`;
  const progressTimer = window.setInterval(() => {
    const value = Math.min(
      92,
      Math.round(((performance.now() - startedAt) / estimateMs) * 92),
    );
    progressBar.value = value;
    query("#baselineProgressLabel").textContent =
      `Running paired scheduler experiments · ${value}%`;
  }, 180);
  try {
    const methods = [
      ...query("#baselineMethods").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    if (!methods.length)
      throw new Error(
        "Select at least one scheduler to run the controlled comparison.",
      );
    if (!methods.includes("proposed"))
      throw new Error(
        "Include SCAN-GRAPH so the comparison can assess its measured outcomes.",
      );
    let result = await request(
      "/experiments/run",
      { scenario: currentState.scenario, replicates: 6, methods },
      120000,
    );
    while (
      ["queued", "pending", "running"].includes(
        String(result.status || "").toLowerCase(),
      ) &&
      (result.id || result.baseline_id)
    ) {
      query("#baselineProgressLabel").textContent =
        "Comparison running on the backend";
      result = await request(
        `/api/baselines/${encodeURIComponent(result.id || result.baseline_id)}`,
      );
    }
    lastComparison = result;
    comparisonScenarioId = currentState.scenario.id;
    renderComparison(lastComparison, currentState.scenario);
    progressBar.value = 100;
    query("#baselineProgressLabel").textContent = "Comparison complete";
    query("#baselineEta").textContent =
      `Completed in ${((performance.now() - startedAt) / 1000).toFixed(1)} seconds`;
  } catch (error) {
    renderHTML(query("#experimentResults"),
      `<section class="panel research-panel form-error">${error.message}</section>`);
  } finally {
    window.clearInterval(progressTimer);
    window.setTimeout(() => progress.classList.add("hidden"), 1800);
    button.disabled = false;
    button.textContent = "Run Controlled Comparison";
  }
}

function exportBaselineCsv() {
  if (!lastComparison?.methods?.length) return;
  const columns = [
    "algorithm",
    "useful_observations",
    "scans",
    "discovery_coverage",
    "recovery_time",
    "exploration_overhead",
    "cpu_seconds",
  ];
  const csv = [
    columns.join(","),
    ...lastComparison.methods.map((item) =>
      columns
        .map((key) => {
          const value = item[key] ?? "";
          return `"${String(value).replaceAll('"', '""')}"`;
        })
        .join(","),
    ),
  ].join("\r\n");
  const file = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `${lastComparison.id || "scan-graph-baseline"}-results.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

query("#step").addEventListener("click", stepScan);
query("#reset").addEventListener("click", resetSimulation);
query("#scenarioForm").addEventListener("submit", generateExperiment);
query("#autoRun").addEventListener("click", () => {
  if (runLoop) {
    runLoop = false;
    setRunControls(false);
  } else runAutoScan();
});
query("#pause").addEventListener("click", () => {
  runLoop = false;
  setRunControls(false);
});
query("#runSpeed").addEventListener("input", (event) => {
  speedMultiplier = Number(event.currentTarget.value) / 100;
  query("#speedValue").value = `${speedMultiplier.toFixed(0)}x`;
});
query("#runGuidedDemo").addEventListener("click", startGuidedDemo);
query("#guidedPause").addEventListener("click", () => {
  runLoop = false;
  setRunControls(false);
});
query("#guidedNext").addEventListener("click", () => {
  if (guidedStage === 2) {
    showTab(query('.nav-item[data-tab="certificate"]'));
    query("#guidedDemo").classList.add("in-certificate");
    setGuidedMoment(
      3,
      "Exclusion certificate",
      "The ruled-out bars show hypotheses weakened by overlapping evidence. The remaining bars stay plausible when observation timing could not rule them out.",
    );
    return;
  }
  if (guidedStage === 3) {
    showTab(query('.nav-item[data-tab="console"]'));
    stepScan();
    return;
  }
  runGuidedUntilMoment();
});
query("#guidedSkip").addEventListener("click", () => {
  guidedActive = false;
  runLoop = false;
  setRunControls(false);
  query("#guidedDemo").classList.add("hidden");
  showTab(query('.nav-item[data-tab="console"]'));
});
document
  .querySelectorAll(".wizard-step")
  .forEach((button) =>
    button.addEventListener("click", () =>
      setWizardStep(button.dataset.wizardStep),
    ),
  );
query(".side-nav").addEventListener("keydown", (event) => {
  if (
    ![
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  const tabs = [...document.querySelectorAll(".nav-item")];
  const current = tabs.indexOf(document.activeElement);
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (forward ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  showTab(tabs[next]);
});
query("#themeToggle").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem("scanGraphTheme", theme);
  applyTheme(theme);
});
query("#generatePreview").addEventListener("click", generatePreview);
query("#resetConfig").addEventListener("click", resetConfiguration);
document
  .querySelectorAll('input[name="scenarioType"]')
  .forEach((radio) => radio.addEventListener("change", updateSelection));
document.querySelectorAll('input[name="hopPattern"]').forEach((radio) =>
  radio.addEventListener("change", () => {
    query("#customSequenceWrap").classList.toggle(
      "hidden",
      radio.value !== "custom" || selectedScenarioType() !== "Frequency Agile",
    );
    updateScenarioPreview();
  }),
);
query("#bandCount").addEventListener("input", () => {
  query("#receiverBands").value = query("#bandCount").value;
  refreshBandOptions();
  syncChangePointLimit();
  updateScenarioPreview();
});
query("#receiverBands").addEventListener("input", () => {
  query("#bandCount").value = query("#receiverBands").value;
  refreshBandOptions();
  updateScenarioPreview();
});
query("#duration").addEventListener("input", () => {
  query("#observationWindow").value = query("#duration").value;
  query("#rareWindow").value = query("#duration").value;
  syncChangePointLimit();
  updateScenarioPreview();
});
query("#observationWindow").addEventListener("input", () => {
  query("#duration").value = query("#observationWindow").value;
  query("#rareWindow").value = query("#duration").value;
  syncChangePointLimit();
  updateScenarioPreview();
});
query("#rareWindow").addEventListener("input", () => {
  query("#duration").value = query("#rareWindow").value;
  query("#observationWindow").value = query("#rareWindow").value;
  syncChangePointLimit();
  updateScenarioPreview();
});
query("#maxDwell").addEventListener("input", () => {
  query("#minDwell").max = query("#maxDwell").value;
  updateScenarioPreview();
});
query("#minDwell").addEventListener("input", () => {
  query("#maxDwell").min = query("#minDwell").value;
  updateScenarioPreview();
});
query("#dutyPercent").addEventListener("input", () => {
  const period = Number(query("#dutyPeriod").value);
  query("#dutyDwell").max = String(period);
  query("#dutyDwell").value = Math.max(
    1,
    Math.min(
      period,
      Math.round((period * Number(query("#dutyPercent").value)) / 100),
    ),
  );
  updateScenarioPreview();
});
query("#dutyDwell").addEventListener("input", () => {
  query("#dutyPercent").value = Math.max(
    1,
    Math.min(
      99,
      Math.round(
        (Number(query("#dutyDwell").value) /
          Number(query("#dutyPeriod").value)) *
          100,
      ),
    ),
  );
  updateScenarioPreview();
});
query("#dutyPeriod").addEventListener("input", () => {
  const period = Number(query("#dutyPeriod").value);
  query("#dutyDwell").max = String(period);
  if (Number(query("#dutyDwell").value) > period)
    query("#dutyDwell").value = String(period);
  query("#dutyPercent").value = Math.max(
    1,
    Math.min(
      99,
      Math.round((Number(query("#dutyDwell").value) / period) * 100),
    ),
  );
  updateScenarioPreview();
});
query("#changePoint").addEventListener("input", updateScenarioPreview);
query("#customSequence").addEventListener("input", updateScenarioPreview);
query("#agileStart").addEventListener("change", () => {
  const option = [...query("#agileBands").options].find(
    (item) => item.value === query("#agileStart").value,
  );
  if (option) option.selected = true;
  updateScenarioPreview();
});
query("#agileBands").addEventListener("change", () => {
  const option = [...query("#agileBands").options].find(
    (item) => item.value === query("#agileStart").value,
  );
  if (option) option.selected = true;
  updateScenarioPreview();
});
query("#hypSearch").addEventListener(
  "input",
  () => currentState && renderHypothesisResearch(currentState),
);
query("#hypStatusFilter").addEventListener(
  "change",
  () => currentState && renderHypothesisResearch(currentState),
);
query("#scenarioForm").addEventListener("input", (event) => {
  if (generatedScenario) {
    generatedScenario = null;
    query("#generatedScenarioSummary").classList.add("hidden");
  }
  if (
    ![
      "bandCount",
      "receiverBands",
      "duration",
      "observationWindow",
      "rareWindow",
      "minDwell",
      "maxDwell",
      "dutyPercent",
      "dutyDwell",
      "dutyPeriod",
      "changePoint",
      "customSequence",
    ].includes(event.target.id)
  )
    updateScenarioPreview();
});
query("#scenarioForm").addEventListener(
  "invalid",
  (event) => {
    const field = event.target;
    const label =
      Array.from(field.labels?.[0]?.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(" ") || "This field";
    const error = query("#scenarioError");
    if (!error.classList.contains("hidden")) return;
    const message = field.validity.valueMissing
      ? `${label} is required.`
      : field.validity.rangeUnderflow
        ? `${label} must be at least ${field.min}.`
        : field.validity.rangeOverflow
          ? `${label} must be no more than ${field.max}.`
          : `Enter a valid value for ${label.toLowerCase()}.`;
    field.setAttribute("aria-invalid", "true");
    error.textContent = message;
    error.classList.remove("hidden", "success-message");
  },
  true,
);
query("#scenarioForm").addEventListener("input", (event) => {
  if (event.target.validity.valid) event.target.removeAttribute("aria-invalid");
  if (query("#scenarioForm").checkValidity())
    query("#scenarioError").classList.add("hidden");
});
query("#scenarioForm").addEventListener("change", () => {
  if (generatedScenario) {
    generatedScenario = null;
    query("#generatedScenarioSummary").classList.add("hidden");
  }
  updateScenarioPreview();
});
query("#export").addEventListener("click", exportCertificate);
query("#printCertificate").addEventListener("click", () => window.print());
query("#exportBaselineCsv").addEventListener("click", exportBaselineCsv);
query("#runexp").addEventListener("click", (event) =>
  runExperiment(event.currentTarget),
);
document
  .querySelectorAll("[data-tab]")
  .forEach((button) => button.addEventListener("click", () => showTab(button)));
query("#backendMode").addEventListener("click", retryBackend);
query("[data-retry-backend]").addEventListener("click", retryBackend);
refreshBandOptions();
updateSelection();
setWizardStep(1);
applyTheme(localStorage.getItem("scanGraphTheme") || "dark");
const savedAtStartup = sessionStorage.getItem("scanGraphScenario");
(savedAtStartup ? loadSavedExperiment() : refresh()).catch((error) => {
  query("#result").textContent =
    `Backend connection failed: ${error.message}. Start backend with: python -m backend`;
  query("#result").classList.add("miss");
});
