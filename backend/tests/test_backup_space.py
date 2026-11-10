"""A backup checks free disk space first (2026-11-10).

Server log 2026-11-10: the nightly backup's uncompressed copy filled the
disk ("database or disk is full"). Now it refuses up front, with the
numbers, and writes nothing; with room it works as before."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from collections import namedtuple

import pytest

Usage = namedtuple("Usage", "total used free")


@pytest.fixture
def bk(monkeypatch):
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp}/db.sqlite")
    monkeypatch.setenv("DROP_SHERLOCK_BACKUP_DIR", f"{tmp}/backups")
    monkeypatch.setenv("DROP_SHERLOCK_BACKUP_MIN_FREE_MB", "512")
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    from app import backups, db as db_mod, models  # noqa: F401
    db_mod.Base.metadata.create_all(bind=db_mod.engine)
    try:
        yield backups
    finally:
        db_mod.engine.dispose()
        shutil.rmtree(tmp, ignore_errors=True)


def test_refuses_when_the_copy_would_fill_the_disk(bk, monkeypatch):
    monkeypatch.setattr(bk.shutil, "disk_usage", lambda _p: Usage(10 * 2**30, 0, 300 * 2**20))
    with pytest.raises(RuntimeError) as e:
        bk.run_backup()
    msg = str(e.value)
    assert msg.startswith("not enough disk space for a backup: 300 MB free, need ")
    assert "512 MB left free" in msg and "Nothing was written." in msg
    assert os.listdir(bk.BACKUP_DIR) == []          # not even the temp copy


def test_backs_up_when_there_is_room(bk, monkeypatch):
    monkeypatch.setattr(bk.shutil, "disk_usage", lambda _p: Usage(10 * 2**30, 0, 5 * 2**30))
    out = bk.run_backup()
    assert out["filename"].endswith(".db.gz")
    assert os.listdir(bk.BACKUP_DIR) == [out["filename"]]


def test_need_counts_the_database_wal_and_headroom(bk, monkeypatch):
    src = bk._resolve_db_path()
    db_bytes = src.stat().st_size
    wal = str(src) + "-wal"
    with open(wal, "wb") as f:
        f.write(b"\0" * 1024 * 1024)
    need = (db_bytes + 2**20) * 5 // 4 + 512 * 2**20
    monkeypatch.setattr(bk.shutil, "disk_usage", lambda _p: Usage(0, 0, need - 1))
    with pytest.raises(RuntimeError, match="not enough disk space"):
        bk._check_free_space(src)
    monkeypatch.setattr(bk.shutil, "disk_usage", lambda _p: Usage(0, 0, need + 2**20))
    bk._check_free_space(src)                        # room: no error
