from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class WikiPageBase(BaseModel):
  slug: str
  title: str
  content: str
  project_id: Optional[int] = None
  parent_id: Optional[int] = None


class WikiPageCreate(BaseModel):
  # Optional: the server derives a unique one from the title when absent.
  slug: Optional[str] = None
  # Optional: blank or missing becomes "Untitled N" on the server.
  title: Optional[str] = None
  content: str = ""
  project_id: Optional[int] = None
  parent_id: Optional[int] = None


class WikiPageUpdate(BaseModel):
  title: Optional[str] = None
  content: Optional[str] = None
  # The page's `updated_at` (or `created_at` if never edited) as the client last saw it.
  # When it no longer matches, someone else saved in between and the write is refused
  # with a 409 instead of silently overwriting their work. Omit it to skip the check.
  base_version: Optional[str] = None
  # Overwrite whatever is there, after the user was told about the conflict and chose to.
  force: bool = False


class WikiPageOut(WikiPageBase):
  id: int
  author_email: Optional[str] = None
  author_name: str
  updated_by_email: Optional[str] = None
  updated_by_name: Optional[str] = None
  created_at: str
  updated_at: Optional[str] = None

  class Config:
    from_attributes = True


class WikiDeleteOut(BaseModel):
  deleted_pages: int


class WikiVersionSummary(BaseModel):
  id: int
  saved_at: str
  saved_by_name: Optional[str] = None
  title: str


class WikiVersionOut(WikiVersionSummary):
  content: str


class WikiAttachmentOut(BaseModel):
  id: int
  page_slug: str
  project_id: int
  filename: str
  file_path: str
  file_size: int
  mime_type: str
  uploaded_by: int
  uploaded_by_name: str
  created_at: datetime
