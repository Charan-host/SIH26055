# SCAN-GRAPH: Exclusion-Certified Spectrum Monitoring

A reproducible research prototype for choosing a receiver band, scan start time, and dwell while accounting for temporal detectability. It includes a deterministic synthetic environment, probabilistic beliefs, discovery deadlines, evidence decay, baseline schedulers, and a certificate generated from observations.

## Run the research console

Start the backend from the project root:

```powershell
python -m backend
```

The API and primary research console are served at `http://localhost:8000`. The API health check is `http://localhost:8000/api/health`. The port and bind host can be changed with `SCAN_GRAPH_PORT` and `SCAN_GRAPH_HOST`.

Alternatively, open `frontend/index.html` with VS Code Live Server. It uses the same centralized API base, `http://localhost:8000`. If the backend cannot be reached, the page visibly switches to **LOCAL SIMULATION MODE** and runs a deterministic browser simulation; use the status button to retry and replay an active local experiment against the live backend.

## Deploy with Vercel and Render

Deploy the frontend to Vercel with `frontend` as the project root directory, `npm run build` as the build command, and `dist` as the output directory. In the Vercel project settings, add `SCAN_GRAPH_API_BASE` with the public HTTPS URL of the Render API (for example, `https://scan-graph-api.onrender.com`), then redeploy so Vite includes it in the frontend build.

Deploy the backend to Render from the repository root using the included `render.yaml` blueprint. After it is live, check `https://<your-render-service>.onrender.com/api/health`, then use that same service URL for `SCAN_GRAPH_API_BASE` in Vercel. Render's injected `PORT` is used automatically. The API currently stores experiments in memory, so they do not persist across service restarts or instance replacements.

Create a scenario, generate its preview, start the experiment, then use **STEP SCAN** in the Receiver Console. Hypotheses, evidence, transitions, and baseline comparisons all use the active scenario and seed.

## Frontend

The single web interface is `frontend/index.html`. Run it with `cd frontend; npm install; npm run dev`, or open it with Live Server. The interface connects to `http://localhost:8000` and enters LOCAL SIMULATION MODE when the backend is unavailable.

## Research mechanism

`backend/core.py` implements the simulation and scheduler. The action search considers band, start time, and dwell. Bayesian MISS updates use temporal overlap: a scan outside the predicted activity window leaves that hypothesis nearly unchanged. The scheduler utility is explicitly a **Prototype scheduling objective**. It combines information gain, exclusion gain, discovery priority, rare-band priority, cost, and redundancy.

The behavior-change scenario transitions from B2 → B6 → B9 to B2 → B4 → B8 at 40 ms. Surprise is calculated from the modeled predictive likelihood of an observation. When a low-probability detection arrives, the prototype decays stale confidence, records an event, and increases recovery exploration.

Intermittent activity uses stable SHA-256 tokens, so a seed produces the same environment across Python processes.

## API

The versioned `/api` routes are experiment-scoped. Legacy `/simulation/*` routes remain available for existing clients.

- `GET /api/health`
- `POST /api/scenarios/generate`
- `POST /api/experiments/start`
- `POST /api/experiments/{id}/step`
- `POST /api/experiments/{id}/reset`
- `GET /api/experiments/{id}`
- `GET /api/experiments/{id}/hypotheses`
- `GET /api/experiments/{id}/evidence`
- `GET /api/experiments/{id}/certificate`
- `POST /api/baselines/run`
- `GET /api/baselines/{id}`

- `POST /simulation/start`
- `POST /simulation/step`
- `POST /simulation/reset`
- `GET /simulation/state`
- `GET /hypotheses`
- `GET /observations`
- `GET /candidate-actions`
- `GET /certificate`
- `GET /scenarios` and `POST /scenarios`
- `POST /experiments/run`
- `GET /experiments/{id}`

Supported schedulers are random, sequential, fixed priority, greedy independent scoring, UCB, Thompson sampling, and SCAN-GRAPH. Experiments use paired scenario seeds, the same horizon, emitter model, receiver model, time slots, and action space. Metrics are calculated from executed simulations; no comparison values are hardcoded.

## Checks

Run the unit and API integration checks:

```powershell
python -m unittest discover -s backend/tests -v
```

## Project files

- `backend/core.py`: environment, Bayesian update, scheduler, certificates, and experiments
- `backend/app.py`: JSON API and fallback console server
- `backend/tests/test_core.py`: overlap, inference, deadline, recovery, certificate, and experiment checks
- `frontend/index.html`: direct-open console for Live Server
- `frontend/src/main.js`: Live Server console logic
- `data/scenarios/behaviour_change.json`: reproducible demo scenario
- `docs/demo.md`: short demo walkthrough

This is a synthetic simulation prototype, not a field RF receiver or validated detector model.
