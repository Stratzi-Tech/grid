import type React from 'react';
import { FileText, FileSpreadsheet, History, Users, File } from 'lucide-react';

export interface WikiTemplate {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  /** Markdown body. A function so dates are "today" when the page is created, not when the app loaded. */
  content: () => string;
}

const today = () => new Date().toLocaleDateString();

export const BLANK_TEMPLATE: WikiTemplate = {
  id: 'blank',
  title: 'Blank page',
  description: 'Start from scratch',
  icon: File,
  content: () => '',
};

export const WIKI_TEMPLATES: WikiTemplate[] = [
  BLANK_TEMPLATE,
  {
    id: 'meeting-notes',
    title: 'Meeting notes',
    description: 'Agenda, discussion and action items',
    icon: Users,
    content: () => `## Details

**Date:** ${today()}

**Attendees:**

-

## Agenda

1.
2.
3.

## Discussion

## Action items

- [ ]
- [ ]

## Next meeting
`,
  },
  {
    id: 'project-plan',
    title: 'Project plan',
    description: 'Goals, timeline and milestones',
    icon: FileSpreadsheet,
    content: () => `## Overview

## Goals

-
-

## Timeline

| Phase | Owner | Start | End |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |

## Milestones

- [ ]
- [ ]

## Risks and mitigation

| Risk | Impact | Mitigation |
| --- | --- | --- |
|  |  |  |
`,
  },
  {
    id: 'requirements',
    title: 'Requirements doc',
    description: 'Problem, user stories and acceptance criteria',
    icon: FileText,
    content: () => `## Problem statement

## User stories

- As a [user], I want [goal] so that [benefit]

## Functional requirements

1.
2.

## Non-functional requirements

- Performance:
- Security:
- Scalability:

## Acceptance criteria

- [ ]
- [ ]
`,
  },
  {
    id: 'retrospective',
    title: 'Retrospective',
    description: 'What went well, what to improve',
    icon: History,
    content: () => `## Details

**Date:** ${today()}

**Sprint:**

## What went well

-
-

## What could be improved

-
-

## Action items

- [ ]
- [ ]

## Shout-outs

-
`,
  },
];
