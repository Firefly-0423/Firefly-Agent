# Skill Template

Starting points for turning recorded learnings into skills. Copy one and adapt it.

---

## SKILL.md Template

```markdown
---
name: skill-name-here
description: "One or two sentences on when and why to reach for this skill, including what triggers it."
---

# Skill Name

A short opening: which problem the skill addresses and where it came from.

## Quick Reference

| When this happens | Do this |
| --- | --- |
| [Trigger 1] | [Action 1] |
| [Trigger 2] | [Action 2] |

## Background

Why this matters, which failures it avoids, and the context carried over from the original learning.

## Solution

### Step-by-Step

1. The first step, with the command or code involved
2. The next step
3. A step that confirms it worked

### Code Example

\`\`\`language
// Sample code that shows the fix
\`\`\`

## Common Variations

- **Variation A**: what it looks like and how to deal with it
- **Variation B**: what it looks like and how to deal with it

## Gotchas

- A warning or frequent mistake (#1)
- A warning or frequent mistake (#2)

## Related

- Pointer to related documentation
- Pointer to a related skill

## Source

Taken from a learning entry.

- **Extraction Date**: YYYY-MM-DD
- **Original Category**: correction | insight | knowledge_gap | best_practice
- **Learning ID**: LRN-YYYYMMDD-XXX
```

---

## Minimal Template

Use this when a skill is small enough to skip most sections:

```markdown
---
name: skill-name-here
description: "What the skill does and when it applies."
---

# Skill Name

[The problem, stated in a single sentence]

## Solution

[The fix, as code or commands]

## Source

- Learning ID: LRN-YYYYMMDD-XXX
```

---

## Template with Scripts

Use this when the skill ships helper programs that can be run:

```markdown
---
name: skill-name-here
description: "What the skill does and when it applies."
---

# Skill Name

[Introduction]

## Quick Reference

| Command | What it is for |
| --- | --- |
| `./scripts/helper.sh` | [Purpose of the helper] |
| `./scripts/validate.sh` | [Purpose of the validator] |

## Usage

### Automated (recommended)

Run the helper directly:

\`\`\`bash
./skills/skill-name/scripts/helper.sh [args]
\`\`\`

### Manual Steps

If the helper is unavailable, do it by hand:

1. First step
2. Second step

## Scripts

Everything under `scripts/`:

| File | Role |
| --- | --- |
| `scripts/helper.sh` | Primary utility |
| `scripts/validate.sh` | Checks the result |

## Source

- Learning ID: LRN-YYYYMMDD-XXX
```

---

## Naming Conventions

- **Skill name**: all lowercase, words joined by hyphens
  - Good: `docker-m1-fixes`, `api-timeout-patterns`
  - Bad: `Docker_M1_Fixes`, `APITimeoutPatterns`

- **Description**: open with a verb and say what triggers the skill
  - Good: "Handles Docker build failures on Apple Silicon. Use when builds fail with platform mismatch."
  - Bad: "Docker stuff"

- **Files**:
  - `SKILL.md` - required; the main document
  - `scripts/` - optional; runnable code
  - `references/` - optional; longer supporting docs
  - `assets/` - optional; templates and other resources

---

## Extraction Checklist

Before turning a learning into a skill, confirm:

- [ ] The learning has been verified (status: resolved)
- [ ] The fix applies widely, not just once
- [ ] The content is self-contained, with all context a reader needs
- [ ] The name follows the conventions above
- [ ] The description is short yet informative
- [ ] The Quick Reference table can be acted on directly
- [ ] The code examples have been tried out
- [ ] The source learning ID is written down

Once the skill exists:

- [ ] Mark the original learning as `promoted_to_skill`
- [ ] Add `Skill-Path: skills/skill-name` to the learning's metadata
- [ ] Read the skill in a fresh session to check that it works
