"""Projects (added 2026-11-09) — what a job's API spend is booked to.

Managed in Settings → Projects; every new Quality job must have one. Jobs
and the spend log point at a project by id, so a rename shows everywhere at
once. Deleting is soft: the project leaves the list and the job form, while
jobs and past spend keep pointing at it, so their history keeps its name.
Names are unique among the live projects, ignoring case."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Job, Project

router = APIRouter(prefix="/projects", tags=["projects"])


def _clean(name: str | None) -> str:
    name = " ".join((name or "").split())[:255]
    if not name:
        raise HTTPException(422, "project name is required")
    return name


def _live(db: Session) -> list[Project]:
    return db.query(Project).filter(Project.deleted_at.is_(None)).all()


def _check_unique(db: Session, name: str, exclude_id: int | None = None) -> None:
    key = name.casefold()
    if any(p.name.casefold() == key and p.id != exclude_id for p in _live(db)):
        raise HTTPException(409, f"a project named “{name}” already exists")


def active_project(db: Session, project_id: int | None) -> Project | None:
    """The project if it exists and isn't deleted — for the job endpoints."""
    if not project_id:
        return None
    p = db.get(Project, project_id)
    return p if p is not None and p.deleted_at is None else None


def _out(p: Project, jobs: int = 0) -> dict:
    return {"id": p.id, "name": p.name, "jobs": jobs,
            "created_at": p.created_at.isoformat() if p.created_at else None}


@router.get("")
def list_projects(
    search: str = "",
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    """Settings → Projects: live projects A–Z, searched and paginated. The
    list is small, so search runs in Python, where case folding also
    covers Cyrillic (SQLite's LIKE / lower() only fold ASCII)."""
    rows = sorted(_live(db), key=lambda p: p.name.casefold())
    total = len(rows)
    q = search.strip().casefold()
    if q:
        rows = [p for p in rows if q in p.name.casefold()]
    filtered = len(rows)
    rows = rows[(page - 1) * per_page: page * per_page]
    counts = _job_counts(db, [p.id for p in rows])
    return {"rows": [_out(p, counts.get(p.id, 0)) for p in rows],
            "total": total, "filtered_total": filtered,
            "page": page, "per_page": per_page}


def _job_counts(db: Session, ids: list[int]) -> dict[int, int]:
    if not ids:
        return {}
    return dict(db.query(Job.project_id, func.count(Job.id))
                .filter(Job.project_id.in_(ids))
                .group_by(Job.project_id).all())


@router.get("/all")
def all_projects(db: Session = Depends(get_db)) -> list[dict]:
    """Every live project, A–Z — the Quality form's searchable dropdown."""
    return [{"id": p.id, "name": p.name}
            for p in sorted(_live(db), key=lambda p: p.name.casefold())]


class ProjectIn(BaseModel):
    name: str


@router.post("", status_code=201)
def create_project(payload: ProjectIn, db: Session = Depends(get_db)) -> dict:
    name = _clean(payload.name)
    _check_unique(db, name)
    p = Project(name=name, created_at=datetime.utcnow())
    db.add(p)
    db.commit()
    return _out(p)


class ProjectsBulkIn(BaseModel):
    names: list[str]


_BULK_MAX = 5000


@router.post("/bulk")
def create_projects_bulk(payload: ProjectsBulkIn, db: Session = Depends(get_db)) -> dict:
    """Paste many names at once (one per line in the UI). Blank lines are
    ignored; a name that already exists — or repeats within the paste,
    ignoring case and extra spaces — is skipped and reported, not an error."""
    if len(payload.names) > _BULK_MAX:
        raise HTTPException(422, f"at most {_BULK_MAX} names per paste")
    taken = {p.name.casefold() for p in _live(db)}
    added: list[str] = []
    skipped: list[str] = []
    now = datetime.utcnow()
    for raw in payload.names:
        name = " ".join((raw or "").split())[:255]
        if not name:
            continue
        if name.casefold() in taken:
            skipped.append(name)
            continue
        taken.add(name.casefold())
        db.add(Project(name=name, created_at=now))
        added.append(name)
    db.commit()
    return {"added": len(added), "skipped": skipped}


@router.patch("/{project_id}")
def rename_project(project_id: int, payload: ProjectIn,
                   db: Session = Depends(get_db)) -> dict:
    p = active_project(db, project_id)
    if p is None:
        raise HTTPException(404, "project not found")
    name = _clean(payload.name)
    _check_unique(db, name, exclude_id=p.id)
    p.name = name
    db.commit()
    return _out(p, _job_counts(db, [p.id]).get(p.id, 0))


@router.delete("/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)) -> dict:
    p = active_project(db, project_id)
    if p is None:
        raise HTTPException(404, "project not found")
    p.deleted_at = datetime.utcnow()
    db.commit()
    return {"deleted": True}
