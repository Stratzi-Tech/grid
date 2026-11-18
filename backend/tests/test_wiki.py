"""Wiki pages: per-project slugs, delete with children, stars and recents."""

import pytest

from app.core.security import CurrentUser

pytestmark = pytest.mark.anyio

ADMIN = CurrentUser(user_id=1, email="admin@example.com", name="Admin", role="admin")
ALICE = CurrentUser(user_id=11, email="alice@example.com", name="Alice", role="user")
BEN = CurrentUser(user_id=12, email="ben@example.com", name="Ben", role="user")


async def seed_members(db):
    await db.project_members.insert_many([
        {"project_id": 1, "user_id": 11, "user_email": "alice@example.com", "role": "member"},
        {"project_id": 1, "user_id": 12, "user_email": "ben@example.com", "role": "member"},
        {"project_id": 2, "user_id": 11, "user_email": "alice@example.com", "role": "member"},
    ])


async def make_page(api, title, project_id=1, parent_id=None, content="x"):
    resp = await api.post("/wiki/", json={
        "title": title, "content": content, "project_id": project_id, "parent_id": parent_id,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_slug_is_generated_and_unique_within_a_project(api, mongo_db):
    first = await make_page(api, "Meeting Notes")
    second = await make_page(api, "Meeting Notes")
    other_project = await make_page(api, "Meeting Notes", project_id=2)

    assert first["slug"] == "meeting-notes"
    assert second["slug"] == "meeting-notes-2"
    # A different project may reuse the slug.
    assert other_project["slug"] == "meeting-notes"


async def test_blank_title_becomes_sequential_untitled_per_project(api, mongo_db):
    first = await make_page(api, "")
    second = await make_page(api, "   ")
    resp = await api.post("/wiki/", json={"content": "x", "project_id": 1})
    assert resp.status_code == 201, resp.text
    other_project = await make_page(api, "", project_id=2)

    assert first["title"] == "Untitled 1"
    assert second["title"] == "Untitled 2"
    assert resp.json()["title"] == "Untitled 3"
    assert other_project["title"] == "Untitled 1"

    renamed = await api.put(f"/wiki/{first['id']}", json={"title": "Real name"})
    assert renamed.json()["title"] == "Real name"
    assert (await make_page(api, ""))["title"] == "Untitled 4"


async def test_pages_with_the_same_slug_in_two_projects_resolve_by_id(api, mongo_db):
    a = await make_page(api, "Overview", project_id=1)
    b = await make_page(api, "Overview", project_id=2, content="second")

    got = await api.get(f"/wiki/{b['id']}")
    assert got.status_code == 200
    assert got.json()["project_id"] == 2
    assert got.json()["content"] == "second"
    assert (await api.get(f"/wiki/{a['id']}")).json()["project_id"] == 1


async def test_rename_keeps_the_slug(api, mongo_db):
    page = await make_page(api, "Old Title")
    resp = await api.put(f"/wiki/{page['id']}", json={"title": "New Title", "content": "body"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "New Title"
    assert resp.json()["slug"] == "old-title"


async def test_parent_must_be_in_the_same_project(api, mongo_db):
    other = await make_page(api, "Elsewhere", project_id=2)
    resp = await api.post("/wiki/", json={
        "title": "Child", "content": "", "project_id": 1, "parent_id": other["id"],
    })
    assert resp.status_code == 400


async def test_delete_removes_the_whole_subtree_and_its_attachments(api, mongo_db):
    root = await make_page(api, "Root")
    child = await make_page(api, "Child", parent_id=root["id"])
    grandchild = await make_page(api, "Grandchild", parent_id=child["id"])
    sibling = await make_page(api, "Sibling")

    await mongo_db.wiki_attachments.insert_many([
        {"id": 1, "project_id": 1, "page_slug": grandchild["slug"], "filename": "a.pdf"},
        {"id": 2, "project_id": 1, "page_slug": sibling["slug"], "filename": "b.pdf"},
    ])
    await api.put(f"/wiki/{child['id']}/star")
    await api.post(f"/wiki/{grandchild['id']}/view")

    resp = await api.delete(f"/wiki/{root['id']}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted_pages": 3}

    for gone in (root, child, grandchild):
        assert (await api.get(f"/wiki/{gone['id']}")).status_code == 404
    assert (await api.get(f"/wiki/{sibling['id']}")).status_code == 200

    # Only the deleted pages' attachments, stars and views are removed.
    remaining = await mongo_db.wiki_attachments.find({}).to_list(length=None)
    assert [a["id"] for a in remaining] == [2]
    assert await mongo_db.wiki_stars.count_documents({}) == 0
    assert await mongo_db.wiki_views.count_documents({}) == 0


async def test_only_author_or_project_admin_can_delete(api, mongo_db):
    await seed_members(mongo_db)

    api.state["user"] = ALICE
    page = await make_page(api, "Alice's page")

    api.state["user"] = BEN
    assert (await api.delete(f"/wiki/{page['id']}")).status_code == 403

    # A project admin who is not the author may delete it.
    await mongo_db.project_members.update_one(
        {"user_id": 12, "project_id": 1}, {"$set": {"role": "admin"}}
    )
    assert (await api.delete(f"/wiki/{page['id']}")).status_code == 200


async def test_author_can_delete_their_own_page(api, mongo_db):
    await seed_members(mongo_db)
    api.state["user"] = ALICE
    page = await make_page(api, "Mine")
    assert (await api.delete(f"/wiki/{page['id']}")).status_code == 200


async def test_non_member_cannot_touch_a_project_page(api, mongo_db):
    page = await make_page(api, "Private")
    api.state["user"] = CurrentUser(user_id=99, email="out@example.com", name="Out", role="user")
    assert (await api.get(f"/wiki/{page['id']}")).status_code == 403
    assert (await api.delete(f"/wiki/{page['id']}")).status_code == 403


async def test_stars_are_per_user(api, mongo_db):
    await seed_members(mongo_db)
    api.state["user"] = ALICE
    page = await make_page(api, "Starry")

    assert (await api.put(f"/wiki/{page['id']}/star")).status_code == 200
    assert (await api.put(f"/wiki/{page['id']}/star")).status_code == 200  # idempotent
    assert (await api.get("/wiki/starred", params={"project_id": 1})).json() == [page["id"]]

    api.state["user"] = BEN
    assert (await api.get("/wiki/starred", params={"project_id": 1})).json() == []

    api.state["user"] = ALICE
    assert (await api.delete(f"/wiki/{page['id']}/star")).status_code == 204
    assert (await api.get("/wiki/starred", params={"project_id": 1})).json() == []


async def test_recent_lists_latest_opened_first_and_is_capped(api, mongo_db):
    pages = [await make_page(api, f"Page {i}") for i in range(12)]
    for page in pages:
        await api.post(f"/wiki/{page['id']}/view")
    # Re-opening an old page moves it to the front instead of duplicating it.
    await api.post(f"/wiki/{pages[0]['id']}/view")

    recent = (await api.get("/wiki/recent", params={"project_id": 1})).json()
    assert len(recent) == 10
    assert recent[0] == pages[0]["id"]
    assert recent[1] == pages[11]["id"]
    assert len(set(recent)) == len(recent)


# ---- Autosave: conflicts and version history --------------------------------------

def token(page):
    return page["updated_at"] or page["created_at"]


async def test_save_with_a_stale_base_version_is_refused(api, mongo_db):
    page = await make_page(api, "Shared")
    first = (await api.put(f"/wiki/{page['id']}", json={
        "content": "mine", "base_version": token(page),
    })).json()

    # A second client still holding the original version is turned away...
    stale = await api.put(f"/wiki/{page['id']}", json={"content": "theirs", "base_version": token(page)})
    assert stale.status_code == 409
    assert (await api.get(f"/wiki/{page['id']}")).json()["content"] == "mine"

    # ...and can overwrite deliberately once told.
    forced = await api.put(f"/wiki/{page['id']}", json={
        "content": "theirs", "base_version": token(page), "force": True,
    })
    assert forced.status_code == 200
    assert forced.json()["content"] == "theirs"
    assert token(first) != token(forced.json())


async def test_a_save_that_changes_nothing_writes_no_version(api, mongo_db):
    page = await make_page(api, "Quiet", content="same")
    resp = await api.put(f"/wiki/{page['id']}", json={"title": "Quiet", "content": "same"})
    assert resp.status_code == 200
    assert await mongo_db.wiki_versions.count_documents({}) == 0
    assert resp.json()["updated_at"] is None


async def test_first_edit_keeps_the_original_and_later_saves_coalesce(api, mongo_db):
    page = await make_page(api, "History", content="original")
    for text in ("a", "ab", "abc"):
        await api.put(f"/wiki/{page['id']}", json={"content": text})

    versions = (await api.get(f"/wiki/{page['id']}/versions")).json()
    # The untouched original, plus ONE entry for the whole editing burst.
    assert len(versions) == 2
    assert "content" not in versions[0]

    newest = (await api.get(f"/wiki/{page['id']}/versions/{versions[0]['id']}")).json()
    oldest = (await api.get(f"/wiki/{page['id']}/versions/{versions[1]['id']}")).json()
    assert newest["content"] == "abc"
    assert oldest["content"] == "original"


async def test_a_different_editor_starts_a_new_version(api, mongo_db):
    await seed_members(mongo_db)
    api.state["user"] = ALICE
    page = await make_page(api, "Two writers", content="v0")
    await api.put(f"/wiki/{page['id']}", json={"content": "alice"})
    api.state["user"] = BEN
    await api.put(f"/wiki/{page['id']}", json={"content": "ben"})

    versions = (await api.get(f"/wiki/{page['id']}/versions")).json()
    assert [v["saved_by_name"] for v in versions] == ["Ben", "Alice", "Alice"]


async def test_history_is_capped_at_fifty_versions(api, mongo_db):
    await seed_members(mongo_db)
    page = await make_page(api, "Busy", content="v0")
    # Alternating editors defeats coalescing, so every save is its own version.
    for i in range(60):
        api.state["user"] = ALICE if i % 2 == 0 else BEN
        await api.put(f"/wiki/{page['id']}", json={"content": f"edit {i}"})

    versions = (await api.get(f"/wiki/{page['id']}/versions")).json()
    assert len(versions) == 50
    newest = (await api.get(f"/wiki/{page['id']}/versions/{versions[0]['id']}")).json()
    assert newest["content"] == "edit 59"


async def test_restore_brings_back_an_old_version_and_is_itself_recorded(api, mongo_db):
    page = await make_page(api, "Restorable", content="original")
    await api.put(f"/wiki/{page['id']}", json={"title": "Changed", "content": "changed"})

    versions = (await api.get(f"/wiki/{page['id']}/versions")).json()
    original = versions[-1]
    restored = await api.post(f"/wiki/{page['id']}/versions/{original['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["content"] == "original"
    assert restored.json()["title"] == "Restorable"

    after = (await api.get(f"/wiki/{page['id']}/versions")).json()
    assert len(after) == len(versions) + 1  # the restore did not overwrite the edit it undid
    assert (await api.get(f"/wiki/{page['id']}/versions/{after[0]['id']}")).json()["content"] == "original"


async def test_version_history_requires_project_access_and_dies_with_the_page(api, mongo_db):
    page = await make_page(api, "Guarded", content="v0")
    await api.put(f"/wiki/{page['id']}", json={"content": "v1"})
    assert await mongo_db.wiki_versions.count_documents({}) == 2

    api.state["user"] = CurrentUser(user_id=99, email="out@example.com", name="Out", role="user")
    assert (await api.get(f"/wiki/{page['id']}/versions")).status_code == 403

    api.state["user"] = ADMIN
    assert (await api.delete(f"/wiki/{page['id']}")).status_code == 200
    assert await mongo_db.wiki_versions.count_documents({}) == 0


async def _age_latest_version(mongo_db, page_id, minutes):
    """Pretend `minutes` have passed since the newest version was written."""
    from datetime import timedelta
    latest = await mongo_db.wiki_versions.find_one({"page_number": page_id}, sort=[("version_number", -1)])
    shift = timedelta(minutes=minutes)
    fields = {"saved_at": latest["saved_at"] - shift}
    if "created_at" in latest:
        fields["created_at"] = latest["created_at"] - shift
    await mongo_db.wiki_versions.update_one({"_id": latest["_id"]}, {"$set": fields})


async def test_steady_editing_opens_a_new_version_every_two_minutes(api, mongo_db):
    page = await make_page(api, "Long session", content="original")
    for i in range(8):
        await api.put(f"/wiki/{page['id']}", json={"content": f"edit {i}"})
        await _age_latest_version(mongo_db, page["id"], 3)  # saves 3 minutes apart

    versions = (await api.get(f"/wiki/{page['id']}/versions")).json()
    # 24 minutes of editing: more than baseline + one entry (the window used to slide).
    assert len(versions) > 2


async def test_editing_after_a_restore_does_not_overwrite_the_restore_entry(api, mongo_db):
    page = await make_page(api, "Restore then type", content="original")
    await api.put(f"/wiki/{page['id']}", json={"content": "changed"})
    oldest = (await api.get(f"/wiki/{page['id']}/versions")).json()[-1]
    await api.post(f"/wiki/{page['id']}/versions/{oldest['id']}/restore")
    await api.put(f"/wiki/{page['id']}", json={"content": "original + more"})

    versions = (await api.get(f"/wiki/{page['id']}/versions")).json()
    texts = [(await api.get(f"/wiki/{page['id']}/versions/{v['id']}")).json()["content"] for v in versions]
    assert texts == ["original + more", "original", "changed", "original"]


# ---- Attachments (shared local/cloud storage) --------------------------------

@pytest.fixture
def storage_tmp(tmp_path, monkeypatch):
    """Point file storage at a throwaway dir so tests never touch real uploads."""
    from app.core import storage as storage_mod

    monkeypatch.delenv("APP_STORAGE_URL", raising=False)
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "uploads"))
    storage_mod.get_storage.cache_clear()
    yield storage_mod
    storage_mod.get_storage.cache_clear()


async def _upload(api, page, name="notes.txt", data=b"hello", project_id=1):
    return await api.post(
        "/wiki/attachments/upload",
        data={"page_slug": page["slug"], "project_id": str(project_id)},
        files={"file": (name, data, "text/plain")},
    )


async def test_attachment_round_trip_upload_list_download_delete(api, mongo_db, storage_tmp):
    page = await make_page(api, "With file")

    resp = await _upload(api, page)
    assert resp.status_code == 200, resp.text
    att = resp.json()
    assert att["filename"] == "notes.txt" and att["file_path"] == "1/notes.txt"
    assert storage_tmp.get_storage().exists("wiki", "1/notes.txt")

    listed = (await api.get(f"/wiki/attachments/{page['slug']}", params={"project_id": 1})).json()
    assert [a["id"] for a in listed] == [att["id"]]

    download = await api.get(f"/wiki/attachments/{att['id']}/download")
    assert download.status_code == 200 and download.content == b"hello"

    assert (await api.delete(f"/wiki/attachments/{att['id']}")).status_code == 204
    assert not storage_tmp.get_storage().exists("wiki", "1/notes.txt")
    assert (await api.get(f"/wiki/attachments/{att['id']}/download")).status_code == 404


async def test_attachment_rejects_bad_type_empty_and_duplicate_name(api, mongo_db, storage_tmp):
    page = await make_page(api, "Rules")

    assert (await _upload(api, page, name="run.exe")).status_code == 400
    assert (await _upload(api, page, data=b"")).status_code == 400
    assert (await _upload(api, page)).status_code == 200
    assert (await _upload(api, page)).status_code == 409


async def test_attachment_name_cannot_escape_the_project_folder(api, mongo_db, storage_tmp):
    page = await make_page(api, "Traversal")
    resp = await _upload(api, page, name="../../evil.txt")
    assert resp.status_code == 200, resp.text
    assert resp.json()["file_path"] == "1/evil.txt"


async def test_attachments_need_project_access(api, mongo_db, storage_tmp):
    await seed_members(mongo_db)
    api.state["user"] = ALICE
    page = await make_page(api, "Alice only", project_id=2)
    att = (await _upload(api, page, project_id=2)).json()

    api.state["user"] = BEN
    assert (await _upload(api, page, project_id=2)).status_code == 403
    assert (await api.get(f"/wiki/attachments/{page['slug']}", params={"project_id": 2})).status_code == 403
    assert (await api.get(f"/wiki/attachments/{att['id']}/download")).status_code == 403
    assert (await api.delete(f"/wiki/attachments/{att['id']}")).status_code == 403


async def test_deleting_a_page_removes_its_stored_files(api, mongo_db, storage_tmp):
    page = await make_page(api, "Doomed")
    await _upload(api, page)
    assert (await api.delete(f"/wiki/{page['id']}")).status_code == 200
    assert not storage_tmp.get_storage().exists("wiki", "1/notes.txt")
    assert await mongo_db.wiki_attachments.count_documents({}) == 0
