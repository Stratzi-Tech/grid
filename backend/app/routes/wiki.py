import logging
import re
from pathlib import Path
from typing import Annotated, List, Optional
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from ..db.mongo import get_mongo_db
from ..schemas.wiki import (
  WikiPageCreate, WikiPageUpdate, WikiPageOut, WikiDeleteOut, WikiVersionOut, WikiVersionSummary,
  WikiAttachmentOut,
)
from ..core.file_security import signature_mismatch
from ..core.security import get_current_user, CurrentUser
from ..core.storage import StorageError, get_storage, serve_stored_file

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/wiki", tags=["wiki"])


async def _author_name_for(db: AsyncIOMotorDatabase, email: Optional[str], stored_name: Optional[str]) -> str:
  """Resolve an author display name preferring the stored name, then user lookup, then email local part."""
  if stored_name:
    return stored_name
  if email:
    user = await db["users"].find_one({"email": email})
    if user and user.get("name"):
      return user.get("name")
    return email.split("@")[0] if "@" in email else email
  return "Unknown"


async def _legacy_author_email(db: AsyncIOMotorDatabase, page: dict) -> Optional[str]:
  """For legacy rows without author_email, derive it from author_id."""
  email = page.get("author_email")
  if email:
    return email
  legacy_id = page.get("author_id")
  if legacy_id:
    user = await db["users"].find_one({"user_number": legacy_id})
    if user:
      return user.get("email")
  return None


async def _legacy_updated_by_email(db: AsyncIOMotorDatabase, page: dict) -> Optional[str]:
  """For legacy rows without updated_by_email, derive it from updated_by_id."""
  email = page.get("updated_by_email")
  if email:
    return email
  legacy_id = page.get("updated_by_id")
  if legacy_id:
    user = await db["users"].find_one({"user_number": legacy_id})
    if user:
      return user.get("email")
  return None


async def verify_project_access(
  project_id: int,
  user_email: str,
  db: AsyncIOMotorDatabase,
  user_role: str = "user",
  user_id: Optional[int] = None,
) -> None:
  """Verify that the user has access to the project (is an active member or admin). Raises 403 if not."""
  # Admins have access to all projects
  if user_role == "admin":
    return

  members_collection = db["project_members"]

  or_clauses: list = [{"user_email": user_email}]
  if user_id is not None:
    or_clauses.append({"user_id": user_id})

  member = await members_collection.find_one({
    "project_id": project_id,
    "$or": or_clauses,
    "$and": [{"$or": [{"active": True}, {"active": {"$exists": False}}]}],
  })

  if not member:
    raise HTTPException(
      status_code=status.HTTP_403_FORBIDDEN,
      detail="You don't have access to this project"
    )


async def _serialize(db: AsyncIOMotorDatabase, page: dict) -> dict:
  author_email = await _legacy_author_email(db, page)
  updated_by_email = await _legacy_updated_by_email(db, page)
  return {
    "id": page.get("page_number"),
    "slug": page.get("slug"),
    "title": page.get("title"),
    "content": page.get("content"),
    "project_id": page.get("project_id"),
    "parent_id": page.get("parent_id"),
    "author_email": author_email,
    "author_name": await _author_name_for(db, author_email, page.get("author_name")),
    "updated_by_email": updated_by_email,
    "updated_by_name": page.get("updated_by_name") or (await _author_name_for(db, updated_by_email, None) if updated_by_email else None),
    "created_at": page.get("created_at"),
    "updated_at": page.get("updated_at"),
  }


def _slugify(text: str) -> str:
  slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
  return slug or "page"


async def _unique_slug(db: AsyncIOMotorDatabase, project_id: Optional[int], wanted: str) -> str:
  """A slug nobody else in this project has: `wanted`, then `wanted-2`, `wanted-3`, ..."""
  base = _slugify(wanted)
  candidate, n = base, 1
  while await db["wiki_pages"].find_one({"project_id": project_id, "slug": candidate}, {"_id": 1}):
    n += 1
    candidate = f"{base}-{n}"
  return candidate


_UNTITLED_RE = re.compile(r"^Untitled (\d+)$")


async def _next_untitled_title(db: AsyncIOMotorDatabase, project_id: Optional[int]) -> str:
  """`Untitled N`, one past the highest `Untitled N` already in this project."""
  rows = await db["wiki_pages"].find(
    {"project_id": project_id, "title": {"$regex": r"^Untitled \d+$"}}, {"title": 1},
  ).to_list(length=None)
  highest = max((int(_UNTITLED_RE.match(r["title"]).group(1)) for r in rows), default=0)
  return f"Untitled {highest + 1}"


async def _get_page_or_404(db: AsyncIOMotorDatabase, page_id: int) -> dict:
  page = await db["wiki_pages"].find_one({"page_number": page_id})
  if not page:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")
  return page


async def _is_project_admin(db: AsyncIOMotorDatabase, project_id: Optional[int], user: CurrentUser) -> bool:
  if user.role == "admin":
    return True
  or_clauses: list = [{"user_email": user.email}]
  if user.id is not None:
    or_clauses.append({"user_id": user.id})
  member = await db["project_members"].find_one({
    "project_id": project_id,
    "role": "admin",
    "$or": or_clauses,
  })
  return member is not None


# ---- Attachments ------------------------------------------------------------
# Files live in the "wiki" category of the shared storage backend (app/core/storage.py:
# local disk or an object store), keyed <project_id>/<filename>. Declared before the
# /{page_id} routes so the literal path wins.

STORAGE_CATEGORY = "wiki"
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024  # 10MB

# Validated by extension (the client-supplied content type is spoofable), then the real
# content signature is re-checked.
ALLOWED_ATTACHMENT_EXTENSIONS = {
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
  ".pdf", ".md", ".markdown", ".txt", ".log", ".rtf",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".csv", ".json", ".zip",
}


def _attachment_key(project_id: int, filename: str) -> str:
  """Storage key ``<project_id>/<safe name>``; ``Path(...).name`` drops any ``../`` or absolute parts."""
  safe_name = Path(filename or "").name
  if not safe_name:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File is missing a name.")
  return f"{project_id}/{safe_name}"


@router.post("/attachments/upload", response_model=WikiAttachmentOut)
async def upload_attachment(
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
  file: UploadFile = File(...),
  page_slug: str = Form(...),
  project_id: int = Form(...),
):
  await verify_project_access(project_id, current_user.email, db, current_user.role, user_id=current_user.id)

  storage_key = _attachment_key(project_id, file.filename)
  safe_filename = Path(storage_key).name

  file_ext = Path(safe_filename).suffix.lower()
  if file_ext not in ALLOWED_ATTACHMENT_EXTENSIONS:
    raise HTTPException(
      status_code=status.HTTP_400_BAD_REQUEST,
      detail=f"File {safe_filename} has an unsupported type ({file_ext or 'no extension'}).",
    )

  content = await file.read()
  if not content:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File is empty.")
  if len(content) > MAX_ATTACHMENT_SIZE:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"File {safe_filename} exceeds 10MB size limit.")

  mismatch = signature_mismatch(safe_filename, content)
  if mismatch:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=mismatch)

  attachments = db["wiki_attachments"]

  # One file per name per project: a re-upload under the same name would overwrite the
  # stored bytes, so refuse it rather than leave two rows pointing at one file.
  if await attachments.find_one({"project_id": project_id, "file_path": storage_key}, {"_id": 1}):
    raise HTTPException(
      status_code=status.HTTP_409_CONFLICT,
      detail=f"A file named {safe_filename} is already attached in this project. Rename it and try again.",
    )

  try:
    get_storage().save(STORAGE_CATEGORY, storage_key, content)
  except StorageError as exc:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

  last = await attachments.find_one(sort=[("id", -1)])
  doc = {
    "id": (last.get("id", 0) + 1) if last else 1,
    "page_slug": page_slug,
    "project_id": project_id,
    "filename": safe_filename,
    "file_path": storage_key,
    "file_size": len(content),
    "mime_type": file.content_type or "application/octet-stream",
    "uploaded_by": current_user.id,
    "uploaded_by_name": current_user.name,
    "created_at": datetime.now(timezone.utc),
  }
  await attachments.insert_one(doc)
  return doc


@router.get("/attachments/{page_slug}", response_model=List[WikiAttachmentOut])
async def list_attachments(
  page_slug: str,
  project_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  await verify_project_access(project_id, current_user.email, db, current_user.role, user_id=current_user.id)
  return await db["wiki_attachments"].find(
    {"page_slug": page_slug, "project_id": project_id}
  ).to_list(length=None)


@router.get("/attachments/{attachment_id:int}/download")
async def download_attachment(
  attachment_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  attachment = await db["wiki_attachments"].find_one({"id": attachment_id})
  if not attachment:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
  await verify_project_access(
    attachment["project_id"], current_user.email, db, current_user.role, user_id=current_user.id
  )

  # Always a download, never rendered on our origin: SVG/HTML can carry script.
  try:
    return serve_stored_file(
      STORAGE_CATEGORY,
      attachment.get("file_path") or "",
      filename=attachment["filename"],
      media_type=attachment.get("mime_type") or "application/octet-stream",
      extra_headers={"X-Content-Type-Options": "nosniff"},
    )
  except (FileNotFoundError, StorageError):
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found on disk")


async def _remove_attachment_file(attachment: dict) -> None:
  """Best-effort removal of the stored file (not its DB row)."""
  stored_key = attachment.get("file_path")
  if not stored_key:
    return
  try:
    get_storage().delete(STORAGE_CATEGORY, stored_key)
  except StorageError:
    logger.error("Refusing to delete out-of-bounds attachment path: %s", stored_key)


@router.delete("/attachments/{attachment_id:int}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(
  attachment_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  attachment = await db["wiki_attachments"].find_one({"id": attachment_id})
  if not attachment:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
  await verify_project_access(
    attachment["project_id"], current_user.email, db, current_user.role, user_id=current_user.id
  )
  await _remove_attachment_file(attachment)
  await db["wiki_attachments"].delete_one({"id": attachment_id})


async def purge_wiki_attachments(db: AsyncIOMotorDatabase, project_id: int, page_slugs: list[str]) -> None:
  """Remove every attachment (file and row) belonging to the given pages of a project."""
  if not page_slugs:
    return
  collection = db["wiki_attachments"]
  query = {"project_id": project_id, "page_slug": {"$in": page_slugs}}
  for attachment in await collection.find(query).to_list(length=None):
    await _remove_attachment_file(attachment)
  await collection.delete_many(query)


# ---- Starred and recent (per user) ----------------------------------------
# Declared before the /{page_id} routes so the literal paths win.

RECENT_LIMIT = 10


@router.get("/starred", response_model=List[int])
async def list_starred(
  project_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  """Ids of the pages the current user has starred in this project."""
  await verify_project_access(project_id, current_user.email, db, current_user.role, user_id=current_user.id)
  rows = await db["wiki_stars"].find({"user_email": current_user.email, "project_id": project_id}).to_list(length=None)
  return [r["page_number"] for r in rows]


@router.get("/recent", response_model=List[int])
async def list_recent(
  project_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
  limit: int = Query(RECENT_LIMIT, ge=1, le=50),
):
  """Ids of the pages the current user opened most recently, newest first."""
  await verify_project_access(project_id, current_user.email, db, current_user.role, user_id=current_user.id)
  rows = await (
    db["wiki_views"]
    .find({"user_email": current_user.email, "project_id": project_id})
    .sort("viewed_at", -1)
    .to_list(length=limit)
  )
  return [r["page_number"] for r in rows]


@router.put("/{page_id:int}/star")
async def star_page(
  page_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)
  await db["wiki_stars"].update_one(
    {"user_email": current_user.email, "page_number": page_id},
    {"$set": {"project_id": page.get("project_id")}},
    upsert=True,
  )
  return {"starred": True}


@router.delete("/{page_id:int}/star", status_code=status.HTTP_204_NO_CONTENT)
async def unstar_page(
  page_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  await db["wiki_stars"].delete_one({"user_email": current_user.email, "page_number": page_id})


@router.post("/{page_id:int}/view")
async def record_view(
  page_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  """Note that the current user just opened this page (drives the Recent tab)."""
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)
  await db["wiki_views"].update_one(
    {"user_email": current_user.email, "page_number": page_id},
    {"$set": {"project_id": page.get("project_id"), "viewed_at": datetime.now(timezone.utc)}},
    upsert=True,
  )
  return {"ok": True}


# ---- Pages ------------------------------------------------------------------

@router.get("/", response_model=List[WikiPageOut])
async def list_pages(
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
  project_id: Optional[int] = Query(None),
):
  if project_id is not None:
    await verify_project_access(project_id, current_user.email, db, current_user.role, user_id=current_user.id)

  query = {}
  if project_id is not None:
    query["project_id"] = project_id

  pages = await db["wiki_pages"].find(query).sort("created_at", -1).to_list(length=None)
  return [await _serialize(db, page) for page in pages]


@router.post("/", response_model=WikiPageOut, status_code=status.HTTP_201_CREATED)
async def create_page(
  payload: WikiPageCreate,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  await verify_project_access(payload.project_id, current_user.email, db, current_user.role, user_id=current_user.id)

  wiki_collection = db["wiki_pages"]

  if payload.parent_id is not None:
    parent = await wiki_collection.find_one({"page_number": payload.parent_id, "project_id": payload.project_id})
    if not parent:
      raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent page not found in this project")

  # Slugs are only for readable URLs and attachment keys: the server picks a free one
  # (`name`, `name-2`, ...) so a duplicate or same-titled page never fails to save.
  title = (payload.title or "").strip() or await _next_untitled_title(db, payload.project_id)
  slug = await _unique_slug(db, payload.project_id, payload.slug or title)

  last_page = await wiki_collection.find_one(sort=[("page_number", -1)])
  next_page_number = (last_page.get("page_number", 0) + 1) if last_page else 1

  now = datetime.now(timezone.utc).isoformat()
  page_doc = {
    "page_number": next_page_number,
    "slug": slug,
    "title": title,
    "content": payload.content,
    "project_id": payload.project_id,
    "parent_id": payload.parent_id,
    "author_email": current_user.email,
    "author_name": current_user.name,
    "updated_by_email": None,
    "updated_by_name": None,
    "created_at": now,
    "updated_at": None,
  }
  await wiki_collection.insert_one(page_doc)
  return await _serialize(db, page_doc)


@router.get("/{page_id:int}", response_model=WikiPageOut)
async def get_page(
  page_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)
  return await _serialize(db, page)


# ---- Version history ----------------------------------------------------------
# Autosave means there is no "Cancel", so every page keeps a short history to go back to.
# Kept cheap on purpose: text only, capped per page, and saves by the same person within
# two minutes update one entry instead of adding another (so typing for an hour is about
# thirty versions at most, not hundreds).

MAX_VERSIONS_PER_PAGE = 50
# Shown to users in frontend/src/components/wiki/VersionHistoryDialog.tsx; keep the text in step.
COALESCE_WINDOW = timedelta(minutes=2)


def _version_token(page: dict) -> Optional[str]:
  return page.get("updated_at") or page.get("created_at")


def _as_aware(value: datetime) -> datetime:
  return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
  if not value:
    return None
  try:
    return _as_aware(datetime.fromisoformat(value))
  except ValueError:
    return None


async def _record_version(
  db: AsyncIOMotorDatabase,
  before: dict,
  title: str,
  content: str,
  user: CurrentUser,
  now: datetime,
  force_new: bool = False,
) -> None:
  """Record the page's new state, keeping the pre-edit state restorable the first time."""
  versions = db["wiki_versions"]
  page_number = before["page_number"]

  latest = await versions.find_one({"page_number": page_number}, sort=[("version_number", -1)])
  next_number = (latest["version_number"] + 1) if latest else 1

  if latest is None:
    # First tracked edit: keep what the page looked like before it, so the original
    # is not lost the moment someone starts typing.
    await versions.insert_one({
      "page_number": page_number,
      "project_id": before.get("project_id"),
      "version_number": next_number,
      "title": before.get("title", ""),
      "content": before.get("content", ""),
      "saved_by_email": before.get("updated_by_email") or before.get("author_email"),
      "saved_by_name": before.get("updated_by_name") or before.get("author_name"),
      "saved_at": _parse_iso(_version_token(before)) or now,
      "baseline": True,
    })
    next_number += 1

  # The window is measured from when the entry was started, not from its last update.
  # Measuring from the last update made it slide: steady editing never opened a new
  # version. Entries written before `created_at` existed fall back to `saved_at`.
  started = _as_aware(latest.get("created_at") or latest["saved_at"]) if latest else None
  coalesce = (
    latest is not None
    and not force_new
    and not latest.get("baseline")
    and not latest.get("restore")  # a restore stays a distinct, restorable entry
    and latest.get("saved_by_email") == user.email
    and now - started < COALESCE_WINDOW
  )
  if coalesce:
    await versions.update_one(
      {"_id": latest["_id"]},
      {"$set": {"title": title, "content": content, "saved_at": now}},
    )
  else:
    await versions.insert_one({
      "page_number": page_number,
      "project_id": before.get("project_id"),
      "version_number": next_number,
      "title": title,
      "content": content,
      "saved_by_email": user.email,
      "saved_by_name": user.name,
      "saved_at": now,
      "created_at": now,
      **({"restore": True} if force_new else {}),
    })

  # Drop the oldest beyond the cap.
  overflow = await versions.count_documents({"page_number": page_number}) - MAX_VERSIONS_PER_PAGE
  if overflow > 0:
    oldest = await versions.find({"page_number": page_number}, {"_id": 1}).sort("version_number", 1).to_list(length=overflow)
    await versions.delete_many({"_id": {"$in": [o["_id"] for o in oldest]}})


@router.put("/{page_id:int}", response_model=WikiPageOut)
async def update_page(
  page_id: int,
  payload: WikiPageUpdate,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)

  # Someone else saved since this client loaded the page: refuse rather than overwrite them.
  if payload.base_version is not None and not payload.force and payload.base_version != _version_token(page):
    raise HTTPException(
      status_code=status.HTTP_409_CONFLICT,
      detail="This page was changed by someone else. Reload to see their changes.",
    )

  new_title = payload.title if payload.title is not None else page.get("title", "")
  new_content = payload.content if payload.content is not None else page.get("content", "")

  # Nothing actually changed (an autosave that fired twice, say): no write, no new version.
  if new_title == page.get("title") and new_content == page.get("content"):
    return await _serialize(db, page)

  now = datetime.now(timezone.utc)

  # The slug is deliberately not touched: attachments and links are keyed by it, so
  # renaming a page must not orphan either.
  update_doc = {
    "title": new_title,
    "content": new_content,
    "updated_by_email": current_user.email,
    "updated_by_name": current_user.name,
    "updated_at": now.isoformat(),
  }

  await _record_version(db, page, new_title, new_content, current_user, now)
  await db["wiki_pages"].update_one({"page_number": page_id}, {"$set": update_doc})
  return await _serialize(db, await _get_page_or_404(db, page_id))


@router.get("/{page_id:int}/versions", response_model=List[WikiVersionSummary])
async def list_versions(
  page_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  """The page's saved versions, newest first. Metadata only; fetch one for its text."""
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)
  rows = await db["wiki_versions"].find(
    {"page_number": page_id}, {"content": 0}
  ).sort("version_number", -1).to_list(length=MAX_VERSIONS_PER_PAGE)
  return [
    {
      "id": r["version_number"],
      "saved_at": _as_aware(r["saved_at"]).isoformat(),
      "saved_by_name": r.get("saved_by_name"),
      "title": r.get("title", ""),
    }
    for r in rows
  ]


async def _get_version_or_404(db: AsyncIOMotorDatabase, page_id: int, version_id: int) -> dict:
  version = await db["wiki_versions"].find_one({"page_number": page_id, "version_number": version_id})
  if not version:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")
  return version


@router.get("/{page_id:int}/versions/{version_id:int}", response_model=WikiVersionOut)
async def get_version(
  page_id: int,
  version_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)
  v = await _get_version_or_404(db, page_id, version_id)
  return {
    "id": v["version_number"],
    "saved_at": _as_aware(v["saved_at"]).isoformat(),
    "saved_by_name": v.get("saved_by_name"),
    "title": v.get("title", ""),
    "content": v.get("content", ""),
  }


@router.post("/{page_id:int}/versions/{version_id:int}/restore", response_model=WikiPageOut)
async def restore_version(
  page_id: int,
  version_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  """Make an earlier version the current page. The restore is recorded as a version too."""
  page = await _get_page_or_404(db, page_id)
  await verify_project_access(page.get("project_id"), current_user.email, db, current_user.role, user_id=current_user.id)
  v = await _get_version_or_404(db, page_id, version_id)

  title, content = v.get("title", ""), v.get("content", "")
  if title != page.get("title") or content != page.get("content"):
    now = datetime.now(timezone.utc)
    # A restore is a deliberate step, so it always gets its own entry rather than
    # being folded into the autosave in progress.
    await _record_version(db, page, title, content, current_user, now, force_new=True)
    await db["wiki_pages"].update_one(
      {"page_number": page_id},
      {"$set": {
        "title": title,
        "content": content,
        "updated_by_email": current_user.email,
        "updated_by_name": current_user.name,
        "updated_at": now.isoformat(),
      }},
    )
  return await _serialize(db, await _get_page_or_404(db, page_id))


@router.delete("/{page_id:int}", response_model=WikiDeleteOut)
async def delete_page(
  page_id: int,
  db: Annotated[AsyncIOMotorDatabase, Depends(get_mongo_db)],
  current_user: Annotated[CurrentUser, Depends(get_current_user)],
):
  """Permanently delete a page, every page nested under it, and their attachments.

  Allowed for the page's author, a project admin, or a global admin.
  """
  page = await _get_page_or_404(db, page_id)
  project_id = page.get("project_id")
  await verify_project_access(project_id, current_user.email, db, current_user.role, user_id=current_user.id)

  is_author = bool(page.get("author_email")) and page.get("author_email") == current_user.email
  if not is_author and not await _is_project_admin(db, project_id, current_user):
    raise HTTPException(
      status_code=status.HTTP_403_FORBIDDEN,
      detail="Only the page author or a project admin can delete this page",
    )

  wiki_collection = db["wiki_pages"]

  # Collect the page and everything nested under it.
  doomed = [page]
  frontier = [page_id]
  while frontier:
    children = await wiki_collection.find(
      {"project_id": project_id, "parent_id": {"$in": frontier}}
    ).to_list(length=None)
    doomed.extend(children)
    frontier = [c["page_number"] for c in children]

  ids = [p["page_number"] for p in doomed]
  slugs = [p["slug"] for p in doomed if p.get("slug")]

  await purge_wiki_attachments(db, project_id, slugs)

  await wiki_collection.delete_many({"page_number": {"$in": ids}})
  await db["wiki_stars"].delete_many({"page_number": {"$in": ids}})
  await db["wiki_views"].delete_many({"page_number": {"$in": ids}})
  await db["wiki_versions"].delete_many({"page_number": {"$in": ids}})

  return {"deleted_pages": len(ids)}
