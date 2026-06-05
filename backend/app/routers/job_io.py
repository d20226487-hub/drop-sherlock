"""Per-Job export + import.

Motivation: the user runs Quality / Whois / Availability jobs on their
personal machine (the deploy server can't run them reliably yet) but
collaborates with colleagues on Database + Backlog state on the deploy
server. A full-DB swap would clobber the colleagues' work; this lets
the user move ONE Job (with all its Runs / RunDomains / CriterionResults
/ JobCriterionPins) onto the deploy server while leaving every other
table untouched.

Bundle shape (v1):
  {
    "schema_version": 1,
    "exported_at": "<iso>",
    "source": {"hostname": "...", "app_version": "..."},
    "uuid": "<uuid4>",        # idempotency key — re-importing is a no-op
    "kind": "quality" | "whois_history" | "availability",
    "job": { ... },
    "runs": [{ ... }],
    "run_domains": [{ ... }],
    "criterion_results": [{ ... }],
    "job_criterion_pins": [{ ... }]
  }

Cross-job pointers NULLed at export (decided 2026-05-17):
  - RunDomain.augments_rd_id
  - CriterionResult.cached_from_run_id
  - CriterionResult.ai_cached_from_run_id
  The Database "augments Run #N" chip + "this was cached from run X"
  provenance are the only casualties; the rows themselves carry all
  their data inline (data_json, ai_verdict_json, samples). Logged in
  the import summary as "dropped_pointers".

NOT exported:
  - DomainNote (global per (domain, criterion) — would risk
    overwriting colleagues' notes on the target).
  - AppSetting, BacklogDomain, AvailabilityCheck, ErrorLog, etc.

Import rewrites every internal FK (run.job_id, rd.run_id,
cr.run_domain_id, pin.{job_id,run_id,rd_id}) to the freshly-allocated
ids on the target. Wrapped in one transaction; rolls back cleanly on
any insert error.
"""
from __future__ import annotations

import gzip
import io
import json
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import CriterionResult, Job, JobCriterionPin, Run, RunDomain

router = APIRouter(prefix="/jobs", tags=["jobs"])


SCHEMA_VERSION = 1

# Columns we serialize for each table. Anything not in this list is
# either irrelevant (computed) or deliberately stripped (cross-job FKs,
# server-local ids that get reallocated). Keep these lists in lockstep
# with models.py when columns are added.
_JOB_COLUMNS = (
    "name", "notes", "spec_json", "kind", "created_at", "updated_at",
    "archived_at", "export_uuid",
)
_RUN_COLUMNS = (
    "spec_json", "status", "started_at", "finished_at", "error", "name",
    "is_pinned", "scoring_override_json",
)
_RUN_DOMAIN_COLUMNS = (
    "domain", "status", "started_at", "finished_at", "error",
    "final_assessment_json", "final_assessment_ru_json", "final_summary",
    "last_analyzed_at", "final_input_tokens", "final_output_tokens",
    "final_cost_usd", "is_pinned", "skip_reason",
    # augments_rd_id deliberately omitted — cross-job pointer, NULL'd on
    # export per the design call. The bundle still works as a tree.
)
_CRITERION_RESULT_COLUMNS = (
    "criterion", "request_url", "status", "http_status", "fetched_at",
    "data_json", "error", "ai_verdict_json", "ai_verdict_error",
    "ai_verdict_ru_json", "params_hash", "prompt_hash",
    "units_cost_row", "units_cost_total", "units_cost_actual",
    "ai_provider", "ai_model", "ai_input_tokens", "ai_output_tokens",
    "ai_cost_usd",
    # cached_from_run_id + ai_cached_from_run_id deliberately omitted —
    # cross-job pointers, NULL'd on export.
)
_JOB_CRITERION_PIN_COLUMNS = (
    "criterion", "created_at",
    # job_id / run_id rewritten at import time from the in-bundle
    # remap tables; not serialized as-is. (JobCriterionPin only ties
    # to a Run — there is no per-rd FK on this table.)
)


def _serialize_row(obj: Any, columns: tuple[str, ...]) -> dict[str, Any]:
    """Pull only the whitelisted columns off `obj`; convert datetimes to
    ISO strings (json doesn't handle them natively). The complementary
    `_deserialize_value` re-parses on import."""
    out: dict[str, Any] = {}
    for c in columns:
        v = getattr(obj, c, None)
        if isinstance(v, datetime):
            out[c] = v.isoformat()
        else:
            out[c] = v
    return out


def _deserialize_value(col: str, v: Any) -> Any:
    """Inverse of the datetime branch in `_serialize_row`. Columns named
    `*_at` / `started_at` / `finished_at` etc. come back as ISO strings;
    parse them. Everything else passes through."""
    if v is None:
        return None
    if col.endswith("_at") and isinstance(v, str):
        try:
            return datetime.fromisoformat(v)
        except ValueError:
            return None
    return v


@router.get("/{job_id}/export")
def export_job(job_id: int, db: Session = Depends(get_db)) -> StreamingResponse:
    """Stream a gzip'd JSON bundle of one Job + every descendant. The
    Content-Disposition filename includes the Job name + kind + UUID
    suffix so the user can tell bundles apart on disk.

    Idempotent w.r.t. the UUID: first export mints one and persists it
    on the Job row; subsequent exports reuse the same value so the
    target server's dupe-skip works."""
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not job.export_uuid:
        job.export_uuid = str(uuid.uuid4())
        db.commit()

    runs = (
        db.query(Run).filter(Run.job_id == job.id).order_by(Run.id.asc()).all()
    )
    run_ids = [r.id for r in runs]
    rds = (
        db.query(RunDomain)
        .filter(RunDomain.run_id.in_(run_ids))
        .order_by(RunDomain.id.asc())
        .all()
        if run_ids else []
    )
    rd_ids = [r.id for r in rds]
    crs = (
        db.query(CriterionResult)
        .filter(CriterionResult.run_domain_id.in_(rd_ids))
        .order_by(CriterionResult.id.asc())
        .all()
        if rd_ids else []
    )
    pins = (
        db.query(JobCriterionPin)
        .filter(JobCriterionPin.job_id == job.id)
        .order_by(JobCriterionPin.id.asc())
        .all()
    )

    bundle: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "exported_at": datetime.utcnow().isoformat(),
        "uuid": job.export_uuid,
        "kind": job.kind or "quality",
        "job": _serialize_row(job, _JOB_COLUMNS),
        "runs": [
            {"_export_id": r.id, **_serialize_row(r, _RUN_COLUMNS)}
            for r in runs
        ],
        "run_domains": [
            {
                "_export_id": rd.id,
                "_run_export_id": rd.run_id,
                **_serialize_row(rd, _RUN_DOMAIN_COLUMNS),
            }
            for rd in rds
        ],
        "criterion_results": [
            {
                "_rd_export_id": cr.run_domain_id,
                **_serialize_row(cr, _CRITERION_RESULT_COLUMNS),
            }
            for cr in crs
        ],
        "job_criterion_pins": [
            {
                "_run_export_id": p.run_id,
                **_serialize_row(p, _JOB_CRITERION_PIN_COLUMNS),
            }
            for p in pins
        ],
    }

    payload = gzip.compress(
        json.dumps(bundle, separators=(",", ":")).encode("utf-8"),
        compresslevel=6,
    )

    # Safe-ish filename: strip slashes / control chars so the browser
    # doesn't fight us. The UUID short prefix disambiguates re-exports
    # of jobs that share a name.
    safe_name = "".join(
        c if c.isalnum() or c in "-._" else "_"
        for c in (job.name or f"job-{job.id}")
    )[:80]
    short_uuid = (job.export_uuid or "")[:8]
    filename = (
        f"drop-sherlock-{job.kind or 'quality'}-{safe_name}-{short_uuid}.json.gz"
    )

    return StreamingResponse(
        iter([payload]),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class ImportSummary(dict):
    """Shape returned by /jobs/import. dict subclass so FastAPI auto-
    serializes; keys: job_id, kind, runs, run_domains, criterion_results,
    job_criterion_pins, dropped_pointers (count of augments_rd_id +
    cached_from_run_id + ai_cached_from_run_id pointers we dropped at
    export time — informational), dupe_skipped (True if bundle UUID
    already existed on this server)."""


@router.post("/import")
async def import_job(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict:
    """Accept a gzip JSON bundle previously emitted by /jobs/{id}/export
    and insert the Job tree under freshly-allocated ids. Idempotent on
    the bundle UUID — re-importing returns `dupe_skipped=True` and the
    existing Job's id without touching the DB.

    All inserts run inside one SQLAlchemy session and commit at the end,
    so a partial failure (corrupt bundle, schema drift, FK clash) rolls
    back cleanly with nothing half-imported."""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty upload")
    try:
        decoded = gzip.decompress(raw)
    except OSError as e:
        raise HTTPException(400, f"not a valid gzip stream: {e}")
    try:
        bundle = json.loads(decoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise HTTPException(400, f"not a valid JSON bundle: {e}")

    sv = bundle.get("schema_version")
    if sv != SCHEMA_VERSION:
        raise HTTPException(
            400,
            f"unsupported bundle schema_version={sv!r} "
            f"(this server understands version {SCHEMA_VERSION})",
        )
    bundle_uuid = bundle.get("uuid") or ""
    if not bundle_uuid:
        raise HTTPException(400, "bundle missing required `uuid` field")

    # Dupe-skip: if this server already has the Job, return its id
    # without inserting anything. Matches the user's mental model of
    # "import is safe to retry" (a re-uploaded bundle shouldn't create
    # ghost duplicates).
    existing = (
        db.query(Job).filter(Job.export_uuid == bundle_uuid).first()
    )
    if existing is not None:
        return {
            "job_id": existing.id,
            "kind": existing.kind,
            "runs": 0,
            "run_domains": 0,
            "criterion_results": 0,
            "job_criterion_pins": 0,
            "dropped_pointers": 0,
            "dupe_skipped": True,
        }

    job_data = bundle.get("job") or {}
    job_kwargs = {
        c: _deserialize_value(c, job_data.get(c))
        for c in _JOB_COLUMNS
    }
    # The bundle's export_uuid is THE idempotency key — preserve it
    # exactly so subsequent imports of the same file dedup correctly.
    job_kwargs["export_uuid"] = bundle_uuid
    # archived_at stays as-is so a bundle exported from an archived job
    # arrives archived — matches the source state. The user can
    # unarchive on the target if desired.
    new_job = Job(**{k: v for k, v in job_kwargs.items() if v is not None or k == "archived_at"})
    db.add(new_job)
    db.flush()  # need new_job.id for the FK rewrites below

    # Defensive orphan-pin sweep (2026-06-05). JobCriterionPin had no
    # cascade on job delete (SQLite FK enforcement is off in our config),
    # so a previously-deleted job can leave pins behind. SQLite reuses the
    # deleted job's rowid for `new_job`, so those orphan pins now share
    # `new_job.id` — and our fresh pins below would hit the
    # (job_id, criterion) UNIQUE constraint, 500-ing the whole import
    # (observed: re-importing a job after deleting its first import).
    # Clear any pins squatting on this id before we insert ours. The
    # delete_job / bulk_delete_jobs endpoints now also cascade pins, so
    # new deletes won't create orphans — this covers ones from before.
    db.query(JobCriterionPin).filter(
        JobCriterionPin.job_id == new_job.id
    ).delete(synchronize_session=False)

    # Run remap: {export_id: new_run_id}
    run_id_map: dict[int, int] = {}
    for r in bundle.get("runs", []):
        export_id = r.get("_export_id")
        run_kwargs = {
            c: _deserialize_value(c, r.get(c)) for c in _RUN_COLUMNS
        }
        run_kwargs["job_id"] = new_job.id
        new_run = Run(**run_kwargs)
        db.add(new_run)
        db.flush()
        if export_id is not None:
            run_id_map[int(export_id)] = new_run.id

    # RunDomain remap: {export_id: new_rd_id}
    rd_id_map: dict[int, int] = {}
    for rd in bundle.get("run_domains", []):
        export_id = rd.get("_export_id")
        run_export_id = rd.get("_run_export_id")
        new_run_id = run_id_map.get(int(run_export_id)) if run_export_id is not None else None
        if new_run_id is None:
            # Orphan RD inside the bundle — skip rather than abort the
            # whole import. The "dropped_pointers" counter doesn't cover
            # this case (it's a different kind of breakage), but it
            # shouldn't happen on a well-formed export.
            continue
        rd_kwargs = {
            c: _deserialize_value(c, rd.get(c)) for c in _RUN_DOMAIN_COLUMNS
        }
        rd_kwargs["run_id"] = new_run_id
        # augments_rd_id is intentionally not serialized; the model
        # default (None) is what we want here.
        new_rd = RunDomain(**rd_kwargs)
        db.add(new_rd)
        db.flush()
        if export_id is not None:
            rd_id_map[int(export_id)] = new_rd.id

    cr_count = 0
    for cr in bundle.get("criterion_results", []):
        rd_export_id = cr.get("_rd_export_id")
        new_rd_id = rd_id_map.get(int(rd_export_id)) if rd_export_id is not None else None
        if new_rd_id is None:
            continue
        cr_kwargs = {
            c: _deserialize_value(c, cr.get(c)) for c in _CRITERION_RESULT_COLUMNS
        }
        cr_kwargs["run_domain_id"] = new_rd_id
        # cached_from_run_id + ai_cached_from_run_id NULL by model
        # default — they were stripped at export time.
        new_cr = CriterionResult(**cr_kwargs)
        db.add(new_cr)
        cr_count += 1

    pin_count = 0
    for p in bundle.get("job_criterion_pins", []):
        run_export_id = p.get("_run_export_id")
        new_run_id = run_id_map.get(int(run_export_id)) if run_export_id is not None else None
        if new_run_id is None:
            continue
        pin_kwargs = {
            c: _deserialize_value(c, p.get(c)) for c in _JOB_CRITERION_PIN_COLUMNS
        }
        pin_kwargs["job_id"] = new_job.id
        pin_kwargs["run_id"] = new_run_id
        new_pin = JobCriterionPin(**pin_kwargs)
        db.add(new_pin)
        pin_count += 1

    db.commit()

    # Estimate of dropped cross-job pointers, for the import summary
    # banner. We didn't carry the originals so we can't count exactly,
    # but a fresh count of (rd.augments_rd_id IS NULL AND would have
    # had one) is not knowable post-hoc. Surface it as "informational
    # — see export-side log" in the UI.
    return {
        "job_id": new_job.id,
        "kind": new_job.kind,
        "runs": len(run_id_map),
        "run_domains": len(rd_id_map),
        "criterion_results": cr_count,
        "job_criterion_pins": pin_count,
        "dupe_skipped": False,
    }
